const supabase = require("../supabase/client");

const TABLE = "conversations";

const Conversation = {
    /**
     * Insert a new conversation row.
     * @param {{
     *   conversationId: string,
     *   senderPSID: string,
     *   userMessage: string,
     *   aiReply: string,
     *   provider: string,
     *   senderName?: string
     * }} data
     */
    async create(data) {
        const row = {
            conversation_id: data.conversationId,
            sender_psid:     data.senderPSID,
            user_message:    data.userMessage,
            ai_reply:        data.aiReply,
            provider:        data.provider,
            sender_name:     data.senderName || "Unknown User",
            timestamp:       new Date().toISOString()
        };

        const { data: inserted, error } = await supabase
            .from(TABLE)
            .insert([row])
            .select()
            .single();

        if (error) throw new Error(`Supabase insert error: ${error.message}`);
        return inserted;
    },

    /**
     * Upsert a conversation row (inserts or updates on conflict).
     * @param {{
     *   conversationId: string,
     *   senderPSID: string,
     *   userMessage: string,
     *   aiReply: string,
     *   provider: string,
     *   senderName?: string,
     *   // NLP classification (optional — null when ML server is down)
     *   intent?: string|null,
     *   urgency?: string|null,
     *   incidentType?: string|null,
     *   intentConfidence?: number|null,
     *   urgencyConfidence?: number|null,
     *   incidentTypeConfidence?: number|null,
     *   barangay?: string|null,
     *   contactNumbers?: string[]|null
     * }} data
     */
    async upsert(data) {
        const row = {
            conversation_id: data.conversationId,
            sender_psid:     data.senderPSID,
            user_message:    data.userMessage,
            ai_reply:        data.aiReply,
            provider:        data.provider || "gemini",
            sender_name:     data.senderName || "Unknown User",
            timestamp:       new Date().toISOString(),
            // Status fields — independent failure domains
            ml_status:                 data.mlStatus                  ?? "pending",
            location_status:           data.locationStatus            ?? "not_found",
            ml_last_attempted_at:      data.mlLastAttemptedAt         ?? new Date().toISOString(),
            needs_review:              data.needsReview               ?? false,
            low_confidence_fields:     data.lowConfidenceFields       ?? null,
            // NLP classification fields (null-safe)
            intent:                    data.intent                    ?? null,
            urgency:                   data.urgency                   ?? null,
            incident_type:             data.incidentType              ?? null,
            intent_confidence:         data.intentConfidence          ?? null,
            urgency_confidence:        data.urgencyConfidence         ?? null,
            incident_type_confidence:  data.incidentTypeConfidence    ?? null,
            barangay:                  data.barangay                  ?? null,
            contact_numbers:           data.contactNumbers            ?? null
        };

        const { data: upserted, error } = await supabase
            .from(TABLE)
            .upsert(row, { onConflict: "conversation_id" })
            .select()
            .single();

        if (error) throw new Error(`Supabase upsert error: ${error.message}`);
        return upserted;
    },

    /**
     * Find conversations where ml_status = 'failed' within a time window.
     * @param {{ limit?: number, hoursAgo?: number }} [options]
     */
    async findFailedMl({ limit = 50, hoursAgo = 24 } = {}) {
        const since = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
        const { data, error } = await supabase
            .from(TABLE)
            .select("conversation_id, user_message, timestamp, ml_last_attempted_at")
            .eq("ml_status", "failed")
            .gte("timestamp", since)
            .order("timestamp", { ascending: false })
            .limit(limit);

        if (error) throw new Error(`Supabase findFailedMl error: ${error.message}`);
        return data || [];
    },

    /**
     * Update ML classification for a specific conversation after retry.
     * @param {string} conversationId
     * @param {{
     *   intent: string,
     *   urgency: string,
     *   incidentType?: string,
     *   incident_type?: string,
     *   intentConfidence?: number,
     *   intent_confidence?: number,
     *   urgencyConfidence?: number,
     *   urgency_confidence?: number,
     *   incidentTypeConfidence?: number,
     *   incident_type_confidence?: number
     * }} nlpResult
     */
    async updateMlClassification(conversationId, nlpResult) {
        const updates = {
            ml_status:                 "complete",
            ml_last_attempted_at:      new Date().toISOString(),
            needs_review:              nlpResult.needs_review             ?? nlpResult.needsReview          ?? false,
            low_confidence_fields:     nlpResult.low_confidence_fields    ?? nlpResult.lowConfidenceFields ?? null,
            intent:                    nlpResult.intent                   ?? null,
            urgency:                   nlpResult.urgency                  ?? null,
            incident_type:             nlpResult.incidentType             ?? nlpResult.incident_type ?? null,
            intent_confidence:         nlpResult.intentConfidence         ?? nlpResult.intent_confidence ?? null,
            urgency_confidence:        nlpResult.urgencyConfidence        ?? nlpResult.urgency_confidence ?? null,
            incident_type_confidence:  nlpResult.incidentTypeConfidence   ?? nlpResult.incident_type_confidence ?? null,
        };

        const { data, error } = await supabase
            .from(TABLE)
            .update(updates)
            .eq("conversation_id", conversationId)
            .select()
            .single();

        if (error) throw new Error(`Supabase updateMlClassification error: ${error.message}`);
        return data;
    },

    /**
     * Record a failed ML retry attempt timestamp without changing status.
     * @param {string} conversationId
     */
    async markMlAttempt(conversationId) {
        const { error } = await supabase
            .from(TABLE)
            .update({ ml_last_attempted_at: new Date().toISOString() })
            .eq("conversation_id", conversationId);

        if (error) console.warn(`⚠️ Failed to update ml_last_attempted_at for ${conversationId}:`, error.message);
    },

    /**
     * Find conversations with optional filter, sort, and limit.
     * Mimics Mongoose: Conversation.find(filter).sort({ timestamp: -1 }).limit(n)
     *
     * Returns a chainable-like object for .sort() and .limit() compatibility.
     */
    find(filter = {}) {
        return new ConversationQuery(filter);
    },

    /**
     * Delete all conversations (or with a filter).
     */
    async deleteMany(filter = {}) {
        let query = supabase.from(TABLE).delete();

        if (filter.senderPSID) {
            query = query.eq("sender_psid", filter.senderPSID);
        } else {
            // Delete all: Supabase requires a condition – use neq on a always-true field
            query = query.neq("conversation_id", "");
        }

        const { data, error, count } = await query.select();
        if (error) throw new Error(`Supabase delete error: ${error.message}`);

        return { deletedCount: data ? data.length : 0 };
    }
};

/**
 * Chainable query builder to mimic Mongoose's fluent API:
 *   Conversation.find(filter).sort({ timestamp: -1 }).limit(10)
 */
class ConversationQuery {
    constructor(filter) {
        this._filter  = filter  || {};
        this._sortCol = "timestamp";
        this._sortAsc = true;
        this._limit   = 100;
    }

    sort(sortObj) {
        // Accept { timestamp: 1 } or { timestamp: -1 }
        const [col, dir] = Object.entries(sortObj)[0];
        // Map camelCase field names to snake_case DB columns
        const colMap = {
            timestamp:    "timestamp",
            senderPSID:   "sender_psid",
            userMessage:  "user_message",
            aiReply:      "ai_reply",
            provider:     "provider",
            conversationId: "conversation_id"
        };
        this._sortCol = colMap[col] || col;
        this._sortAsc = dir === 1;
        return this;
    }

    limit(n) {
        this._limit = n;
        return this;
    }

    /**
     * Make the query thenable so `await Conversation.find(...).sort(...).limit(...)` works.
     */
    then(resolve, reject) {
        this._execute().then(resolve).catch(reject);
    }

    async _execute() {
        let query = supabase
            .from(TABLE)
            .select("*")
            .order(this._sortCol, { ascending: this._sortAsc })
            .limit(this._limit);

        if (this._filter.senderPSID) {
            query = query.eq("sender_psid", this._filter.senderPSID);
        }

        const { data, error } = await query;
        if (error) throw new Error(`Supabase select error: ${error.message}`);

        // Normalize snake_case columns back to camelCase to match existing code
        return (data || []).map(row => ({
            conversationId: row.conversation_id,
            senderPSID:     row.sender_psid,
            senderName:     row.sender_name || "Unknown User",
            userMessage:    row.user_message,
            aiReply:        row.ai_reply,
            provider:       row.provider,
            timestamp:      row.timestamp
        }));
    }
}

module.exports = Conversation;
