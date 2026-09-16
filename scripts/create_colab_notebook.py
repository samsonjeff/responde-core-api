import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ML_DIR = ROOT / "ml"
DATASETS_DIR = ROOT / "datasets"

def make_colab_notebook():
    cells = []

    def md_cell(source):
        return {
            "cell_type": "markdown",
            "metadata": {},
            "source": [line + "\n" for line in source.strip().split("\n")]
        }

    def code_cell(source):
        return {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": [line + "\n" for line in source.strip().split("\n")]
        }

    # 1. Header
    cells.append(md_cell("""# 🚒 Responde NLP — RoBERTa-Tagalog Multi-Task Fine-Tuning on Google Colab

Train the Tagalog multi-task classifier (`jcblaise/roberta-tagalog-base`) for the **Responde** disaster response system using a **free T4 GPU** in Google Colab (~3–5 minutes).

### 🎯 Tasks Learned Simultaneously:
1. **Intent** (7 classes): `EMERGENCY_REPORT`, `RESOURCE_REQUEST`, `CASUALTY_REPORT`, `STATUS_INQUIRY`, etc.
2. **Urgency** (4 classes): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`
3. **Incident Type** (7 classes): `earthquake`, `fire`, `flood`, `landslide`, `none`, `typhoon`, `volcanic_eruption`

---

### ⚡ Step 0: Ensure GPU is Enabled
Go to **Runtime** ➔ **Change runtime type** ➔ Select **T4 GPU** ➔ Click **Save**."""))

    # 2. Check GPU
    cells.append(md_cell("### 1. Check GPU Status"))
    cells.append(code_cell("!nvidia-smi"))

    # 3. Dependencies
    cells.append(md_cell("### 2. Install Required Packages"))
    cells.append(code_cell("!pip install -q transformers torch scikit-learn accelerate"))

    # 4. Upload Datasets
    cells.append(md_cell("""### 3. Upload Dataset Files
You can upload either:
- The 3 individual files: `train.jsonl`, `val.jsonl`, `test.jsonl` (found in `datasets/`)
- OR a zip file containing them: `datasets.zip`"""))
    cells.append(code_cell("""import os
import zipfile
from pathlib import Path
from google.colab import files

DATASETS_DIR = Path("datasets")
DATASETS_DIR.mkdir(exist_ok=True)

print("Please select train.jsonl, val.jsonl, and test.jsonl (or datasets.zip) to upload:")
uploaded = files.upload()

for filename in uploaded.keys():
    if filename.endswith(".zip"):
        print(f"Extracting {filename}...")
        with zipfile.ZipFile(filename, 'r') as zip_ref:
            zip_ref.extractall(DATASETS_DIR)
    elif filename.endswith(".jsonl"):
        dest = DATASETS_DIR / filename
        with open(dest, "wb") as f:
            f.write(uploaded[filename])
        print(f"Saved {filename} to {dest}")

# Verify files
train_ok = (DATASETS_DIR / "train.jsonl").exists()
val_ok = (DATASETS_DIR / "val.jsonl").exists()
test_ok = (DATASETS_DIR / "test.jsonl").exists()

print("\\nDataset check:")
print(f"  train.jsonl: {'✅ Present' if train_ok else '❌ Missing'}")
print(f"  val.jsonl:   {'✅ Present' if val_ok else '❌ Missing'}")
print(f"  test.jsonl:  {'✅ Present' if test_ok else '❌ Missing'}")
assert train_ok and val_ok, "Missing train.jsonl or val.jsonl!"
"""))

    # 5. Define Model Architecture & Dataset
    cells.append(md_cell("### 4. Model Architecture & Data Loaders"))
    cells.append(code_cell("""import json
import torch
import torch.nn as nn
from collections import Counter
from torch.utils.data import DataLoader, Dataset
from transformers import (
    AutoTokenizer,
    AutoConfig,
    RobertaModel,
    RobertaPreTrainedModel,
    get_linear_schedule_with_warmup,
)
from sklearn.metrics import f1_score, classification_report

BASE_MODEL = "jcblaise/roberta-tagalog-base"

# Label definitions matching Responde core API
INTENT_LABELS = sorted([
    "CASUAL_OR_GREETING",
    "CASUALTY_REPORT",
    "EMERGENCY_REPORT",
    "FEEDBACK_OR_THANKS",
    "OTHER",
    "RESOURCE_REQUEST",
    "STATUS_INQUIRY",
])

URGENCY_LABELS = sorted(["CRITICAL", "HIGH", "LOW", "MEDIUM"])

INCIDENT_LABELS = sorted([
    "earthquake",
    "fire",
    "flood",
    "landslide",
    "none",
    "typhoon",
    "volcanic_eruption",
])

INTENT2ID   = {l: i for i, l in enumerate(INTENT_LABELS)}
URGENCY2ID  = {l: i for i, l in enumerate(URGENCY_LABELS)}
INCIDENT2ID = {l: i for i, l in enumerate(INCIDENT_LABELS)}

ID2INTENT   = {i: l for l, i in INTENT2ID.items()}
ID2URGENCY  = {i: l for l, i in URGENCY2ID.items()}
ID2INCIDENT = {i: l for l, i in INCIDENT2ID.items()}


def compute_class_weights(dataset, field, label2id, device):
    counts = Counter()
    for sample in dataset.samples:
        counts[sample[field]] += 1
    n_classes = len(label2id)
    total = sum(counts.values())
    weights = torch.ones(n_classes, device=device)
    for cls_id in range(n_classes):
        count = counts.get(cls_id, 0)
        if count > 0:
            weights[cls_id] = total / (n_classes * count)
    return weights


def load_jsonl(path):
    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return records


class RespondeDataset(Dataset):
    def __init__(self, records, tokenizer, max_length=128):
        self.samples = []
        skipped = 0
        for rec in records:
            text = (rec.get("text") or "").strip()
            if not text:
                skipped += 1
                continue
            intent   = rec.get("intent", "OTHER")
            urgency  = rec.get("urgency", "LOW")
            incident = rec.get("incident_type", "none")

            if intent not in INTENT2ID:     intent = "OTHER"
            if urgency not in URGENCY2ID:   urgency = "LOW"
            if incident not in INCIDENT2ID: incident = "none"

            self.samples.append({
                "text":     text,
                "intent":   INTENT2ID[intent],
                "urgency":  URGENCY2ID[urgency],
                "incident": INCIDENT2ID[incident],
            })

        self.tokenizer = tokenizer
        self.max_length = max_length
        if skipped:
            print(f"Skipped {skipped} records with empty text.")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        sample = self.samples[idx]
        enc = self.tokenizer(
            sample["text"],
            max_length=self.max_length,
            padding="max_length",
            truncation=True,
            return_tensors="pt",
        )
        return {
            "input_ids":      enc["input_ids"].squeeze(0),
            "attention_mask": enc["attention_mask"].squeeze(0),
            "intent_label":   torch.tensor(sample["intent"],   dtype=torch.long),
            "urgency_label":  torch.tensor(sample["urgency"],  dtype=torch.long),
            "incident_label": torch.tensor(sample["incident"], dtype=torch.long),
        }


def _make_head(in_features, n_classes, dropout_p=0.2):
    return nn.Sequential(
        nn.Linear(in_features, 256),
        nn.ReLU(),
        nn.Dropout(dropout_p),
        nn.Linear(256, n_classes),
    )


class MultiTaskRoberta(RobertaPreTrainedModel):
    def __init__(self, config, n_intent, n_urgency, n_incident):
        super().__init__(config)
        self.roberta = RobertaModel(config, add_pooling_layer=False)
        hidden = config.hidden_size
        dropout_p = getattr(config, "classifier_dropout", None) or 0.1

        self.dropout       = nn.Dropout(dropout_p)
        self.intent_head   = _make_head(hidden, n_intent)
        self.urgency_head  = _make_head(hidden, n_urgency)
        self.incident_head = _make_head(hidden, n_incident)

        self.intent_weights   = None
        self.urgency_weights  = None
        self.incident_weights = None
        self.label_smoothing  = 0.1

        self.post_init()

    def set_class_weights(self, intent_w, urgency_w, incident_w):
        self.intent_weights   = intent_w
        self.urgency_weights  = urgency_w
        self.incident_weights = incident_w

    def forward(self, input_ids, attention_mask, labels=None):
        outputs = self.roberta(input_ids=input_ids, attention_mask=attention_mask)
        cls = self.dropout(outputs.last_hidden_state[:, 0, :])

        logits_intent   = self.intent_head(cls)
        logits_urgency  = self.urgency_head(cls)
        logits_incident = self.incident_head(cls)

        loss = None
        if labels is not None:
            ls = self.label_smoothing
            loss_i = nn.CrossEntropyLoss(weight=self.intent_weights,   label_smoothing=ls)
            loss_u = nn.CrossEntropyLoss(weight=self.urgency_weights,  label_smoothing=ls)
            loss_c = nn.CrossEntropyLoss(weight=self.incident_weights, label_smoothing=ls)
            loss = (
                loss_i(logits_intent,   labels["intent"]) +
                loss_u(logits_urgency,  labels["urgency"]) +
                loss_c(logits_incident, labels["incident"])
            )

        return loss, logits_intent, logits_urgency, logits_incident
"""))

    # 6. Training Function & Execution
    cells.append(md_cell("### 5. Run Fine-Tuning (T4 GPU)"))
    cells.append(code_cell("""import time
from pathlib import Path

MODEL_DIR = Path("model")
MODEL_DIR.mkdir(exist_ok=True)

EPOCHS = 12
BATCH_SIZE = 16  # GPU can easily handle batch size 16
LR = 3e-5
MAX_LEN = 128

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Device: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'No GPU'})")

print("Loading tokenizer and datasets...")
tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
train_records = load_jsonl(DATASETS_DIR / "train.jsonl")
val_records   = load_jsonl(DATASETS_DIR / "val.jsonl")

train_ds = RespondeDataset(train_records, tokenizer, max_length=MAX_LEN)
val_ds   = RespondeDataset(val_records,   tokenizer, max_length=MAX_LEN)

train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True,  num_workers=2)
val_loader   = DataLoader(val_ds,   batch_size=BATCH_SIZE, shuffle=False, num_workers=2)

print(f"Train samples: {len(train_ds)} | Val samples: {len(val_ds)}")

# Class weights (inverse-frequency)
print("Computing class weights (inverse-frequency)...")
w_intent   = compute_class_weights(train_ds, "intent",   INTENT2ID,   device)
w_urgency  = compute_class_weights(train_ds, "urgency",  URGENCY2ID,  device)
w_incident = compute_class_weights(train_ds, "incident", INCIDENT2ID, device)
print(f"  Intent weights:   {[f'{v:.2f}' for v in w_intent.tolist()]}")
print(f"  Urgency weights:  {[f'{v:.2f}' for v in w_urgency.tolist()]}")
print(f"  Incident weights: {[f'{v:.2f}' for v in w_incident.tolist()]}")

# Model initialization
print(f"Initializing {BASE_MODEL}...")
config = AutoConfig.from_pretrained(BASE_MODEL)
model = MultiTaskRoberta.from_pretrained(
    BASE_MODEL,
    config=config,
    n_intent=len(INTENT_LABELS),
    n_urgency=len(URGENCY_LABELS),
    n_incident=len(INCIDENT_LABELS),
    ignore_mismatched_sizes=True,
).to(device)
model.set_class_weights(w_intent, w_urgency, w_incident)

optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
total_steps = len(train_loader) * EPOCHS
scheduler = get_linear_schedule_with_warmup(
    optimizer,
    num_warmup_steps=max(1, total_steps // 7),  # ~15% warmup
    num_training_steps=total_steps,
)

@torch.no_grad()
def evaluate(model, loader):
    model.eval()
    all_intent, all_urgency, all_incident = [], [], []
    pred_intent, pred_urgency, pred_incident = [], [], []
    total_loss, n_batches = 0.0, 0

    for batch in loader:
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)
        labels = {
            "intent":   batch["intent_label"].to(device),
            "urgency":  batch["urgency_label"].to(device),
            "incident": batch["incident_label"].to(device),
        }
        loss, li, lu, linc = model(input_ids, attention_mask, labels=labels)
        total_loss += loss.item()
        n_batches += 1

        all_intent.extend(labels["intent"].cpu().tolist())
        all_urgency.extend(labels["urgency"].cpu().tolist())
        all_incident.extend(labels["incident"].cpu().tolist())

        pred_intent.extend(li.argmax(dim=1).cpu().tolist())
        pred_urgency.extend(lu.argmax(dim=1).cpu().tolist())
        pred_incident.extend(linc.argmax(dim=1).cpu().tolist())

    f1_i = f1_score(all_intent, pred_intent, average="macro", zero_division=0)
    f1_u = f1_score(all_urgency, pred_urgency, average="macro", zero_division=0)
    f1_c = f1_score(all_incident, pred_incident, average="macro", zero_division=0)

    return {
        "loss": total_loss / max(n_batches, 1),
        "f1_intent": f1_i,
        "f1_urgency": f1_u,
        "f1_incident": f1_c,
        "avg_f1": (f1_i + f1_u + f1_c) / 3,
    }

best_f1 = -1.0
best_epoch = -1
start_time = time.time()

print("\\nStarting training loop...")
for epoch in range(1, EPOCHS + 1):
    model.train()
    epoch_loss = 0.0
    n_batches = 0

    for step, batch in enumerate(train_loader, 1):
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)
        labels = {
            "intent":   batch["intent_label"].to(device),
            "urgency":  batch["urgency_label"].to(device),
            "incident": batch["incident_label"].to(device),
        }

        optimizer.zero_grad()
        loss, *_ = model(input_ids, attention_mask, labels=labels)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()

        epoch_loss += loss.item()
        n_batches += 1

    val_metrics = evaluate(model, val_loader)
    train_loss = epoch_loss / max(n_batches, 1)

    print(
        f"Epoch {epoch}/{EPOCHS} | Train Loss: {train_loss:.4f} | "
        f"Val Loss: {val_metrics['loss']:.4f} | "
        f"Intent F1: {val_metrics['f1_intent']:.3f} | "
        f"Urgency F1: {val_metrics['f1_urgency']:.3f} | "
        f"Incident F1: {val_metrics['f1_incident']:.3f} | "
        f"Avg F1: {val_metrics['avg_f1']:.3f}"
    )

    if val_metrics["avg_f1"] > best_f1:
        best_f1 = val_metrics["avg_f1"]
        best_epoch = epoch
        model.save_pretrained(MODEL_DIR)
        tokenizer.save_pretrained(MODEL_DIR)

        label_maps = {
            "intent":        {"id2label": ID2INTENT,   "label2id": INTENT2ID},
            "urgency":       {"id2label": ID2URGENCY,  "label2id": URGENCY2ID},
            "incident_type": {"id2label": ID2INCIDENT, "label2id": INCIDENT2ID},
        }
        with open(MODEL_DIR / "label_maps.json", "w", encoding="utf-8") as f:
            json.dump(label_maps, f, indent=2)

        print(f"  --> Saved best model checkpoint (Epoch {epoch}, Avg F1: {best_f1:.3f})")

elapsed = time.time() - start_time
print(f"\\nTraining complete in {elapsed/60:.2f} minutes!")
print(f"Best Epoch: {best_epoch} with Validation Avg Macro F1: {best_f1:.3f}")
"""))

    # 7. Evaluate on Test Set
    cells.append(md_cell("### 6. Evaluate Model on Test Set (`test.jsonl`)"))
    cells.append(code_cell("""if (DATASETS_DIR / "test.jsonl").exists():
    print("Evaluating best saved checkpoint on unseen Test Set...")
    test_records = load_jsonl(DATASETS_DIR / "test.jsonl")
    test_ds = RespondeDataset(test_records, tokenizer, max_length=MAX_LEN)
    test_loader = DataLoader(test_ds, batch_size=16, shuffle=False)

    best_model = MultiTaskRoberta.from_pretrained(
        MODEL_DIR,
        config=config,
        n_intent=len(INTENT_LABELS),
        n_urgency=len(URGENCY_LABELS),
        n_incident=len(INCIDENT_LABELS),
    ).to(device)
    best_model.eval()

    all_intent, all_urgency, all_incident = [], [], []
    pred_intent, pred_urgency, pred_incident = [], [], []

    with torch.no_grad():
        for batch in test_loader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = {
                "intent":   batch["intent_label"].to(device),
                "urgency":  batch["urgency_label"].to(device),
                "incident": batch["incident_label"].to(device),
            }
            _, li, lu, linc = best_model(input_ids, attention_mask, labels=labels)

            all_intent.extend(labels["intent"].cpu().tolist())
            all_urgency.extend(labels["urgency"].cpu().tolist())
            all_incident.extend(labels["incident"].cpu().tolist())

            pred_intent.extend(li.argmax(dim=1).cpu().tolist())
            pred_urgency.extend(lu.argmax(dim=1).cpu().tolist())
            pred_incident.extend(linc.argmax(dim=1).cpu().tolist())

    print("=" * 60)
    print("INTENT CLASSIFICATION REPORT:")
    print(classification_report(all_intent, pred_intent, target_names=INTENT_LABELS, zero_division=0))

    print("=" * 60)
    print("URGENCY CLASSIFICATION REPORT:")
    print(classification_report(all_urgency, pred_urgency, target_names=URGENCY_LABELS, zero_division=0))

    print("=" * 60)
    print("INCIDENT TYPE CLASSIFICATION REPORT:")
    print(classification_report(all_incident, pred_incident, target_names=INCIDENT_LABELS, zero_division=0))
else:
    print("test.jsonl not found, skipping final test evaluation.")
"""))

    # 8. Interactive Test Inference
    cells.append(md_cell("### 7. Interactive Test Prediction"))
    cells.append(code_cell("""import torch.nn.functional as F

def predict(text):
    best_model.eval()
    enc = tokenizer(text, max_length=128, padding="max_length", truncation=True, return_tensors="pt")
    input_ids = enc["input_ids"].to(device)
    attention_mask = enc["attention_mask"].to(device)

    with torch.no_grad():
        _, li, lu, linc = best_model(input_ids, attention_mask)
        p_intent = F.softmax(li, dim=1).squeeze(0)
        p_urgency = F.softmax(lu, dim=1).squeeze(0)
        p_incident = F.softmax(linc, dim=1).squeeze(0)

        i_idx, u_idx, c_idx = p_intent.argmax().item(), p_urgency.argmax().item(), p_incident.argmax().item()

    return {
        "text": text,
        "intent": ID2INTENT[i_idx],
        "intent_confidence": round(p_intent[i_idx].item(), 3),
        "urgency": ID2URGENCY[u_idx],
        "urgency_confidence": round(p_urgency[u_idx].item(), 3),
        "incident_type": ID2INCIDENT[c_idx],
        "incident_type_confidence": round(p_incident[c_idx].item(), 3),
    }

# Test with a Tagalog disaster message sample
sample_msg = "Tulong po! Baha na hanggang bubong dito sa Barangay Poblacion, may matanda at bata kaming kasama!"
print(json.dumps(predict(sample_msg), indent=2))
"""))

    # 9. Package & Download Model
    cells.append(md_cell("""### 8. Download Trained Model Weights (`responde_nlp_model.zip`)
Running this cell will zip the trained model files and prompt your browser to download `responde_nlp_model.zip`.

Once downloaded, extract the contents into your project folder:
`responde-core-api/ml/model/`"""))
    cells.append(code_cell("""import shutil
from google.colab import files

zip_path = shutil.make_archive("responde_nlp_model", "zip", "model")
print(f"Archive created: {zip_path}")
print("Triggering browser download...")
files.download(zip_path)
"""))

    notebook = {
        "nbformat": 4,
        "nbformat_minor": 0,
        "metadata": {
            "colab": {
                "provenance": [],
                "gpuType": "T4",
                "name": "Responde_NLP_Train.ipynb"
            },
            "kernelspec": {
                "display_name": "Python 3",
                "name": "python3"
            },
            "language_info": {
                "name": "python"
            }
        },
        "cells": cells
    }

    out_file = ML_DIR / "Responde_NLP_Train.ipynb"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(notebook, f, indent=1)
    print(f"Notebook generated successfully at {out_file}")

    # Also generate datasets.zip for convenient 1-click upload
    zip_dest = DATASETS_DIR / "datasets.zip"
    with zipfile.ZipFile(zip_dest, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in ["train.jsonl", "val.jsonl", "test.jsonl"]:
            fpath = DATASETS_DIR / fname
            if fpath.exists():
                zf.write(fpath, arcname=fname)
    print(f"Created convenient upload package at {zip_dest}")

if __name__ == "__main__":
    make_colab_notebook()
