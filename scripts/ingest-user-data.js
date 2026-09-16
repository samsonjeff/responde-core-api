/**
 * scripts/ingest-user-data.js
 *
 * Ingests and annotates 335 user-supplied natural disaster / emergency messages
 * into the synthetic_dataset and updates annotated_dataset and splits.
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const geminiPool = require("../utils/geminiKeyPool");
const { BARANGAYS } = require("../utils/extractors");

const DATASETS_DIR = path.resolve(__dirname, "../datasets");
const SYNTHETIC_JSONL = path.join(DATASETS_DIR, "synthetic_dataset.jsonl");
const SYNTHETIC_CSV = path.join(DATASETS_DIR, "synthetic_dataset.csv");
const ANNOTATED_JSONL = path.join(DATASETS_DIR, "annotated_dataset.jsonl");
const ANNOTATED_CSV = path.join(DATASETS_DIR, "annotated_dataset.csv");
const CLEANED_REAL_JSONL = path.join(DATASETS_DIR, "cleaned_real_dataset.jsonl");

const RAW_MESSAGES = [
    `Salamat po sa rescue team dine samen, ala eh pinuntahan nila kami kahit gabi na eh, maigi at ligtas na kami dine sa Brgy Balas`,
    `Thank you to everyone who donated supplies for our evacuation center here in Brgy. Buco`,
    `Ala eh tulong naman po! Natabunan na ang daan sa Brgy. Leynes gawa ng landslide, di makadaan ang ambulansya!`,
    `Wala pa rin pong kuryente at signal sa Poblacion 2. Marami na po naputol na poste d2 sa kalsada paki ayos po`,
    `PUTOL N KURYENTE ILANG ORAS N D2 SA BRGY Poblacion 2 MAY NAKALAWIT PANG WIRE SA daan papuntang bundok DELIKADO PO`,
    `Padine po kayo, baluktot na ang poste malapit sa bahay namin, baka bumagsak pa sa daan, Brgy Poblacion 6.`,
    `natumba ung malaking puno kasama poste sa may boundary ng Laurel blocked n daan papuntang Brgy Caloocan`,
    `Paano po mag-request ng dagdag na pagkain para sa mga bata dito sa center, malapit sa covered court, Brgy Balas`,
    `hi po ask ko lng kung san po pwd magdonate ng relief goods para sa Brgy Buco"`,
    `A family in Brgy. Sampaloc is stranded and needs some immediate evacuation assistance!`,
    `mAy nA-stuck SA Sampaloc pLs r3scu3 now!!!😭`,
    `Blocked yung road sa Brgy. 5 dahil sa volcanic ash, hindi makadaan ang mga vehicles`,
    `Saan kaya ang evacuation center na malapit sa Barangay Balas?`,
    `Wala nang maiinom na malinis na tubig sa Barangay Balas, pakiabutan naman kami ng tubig o😭😔`,
    `HIRAP HUMINGA D2 Pob 3 dhl sA aBo!!! NEED MEDIC PLS ASAP!!!`,
    `May residents na stranded sa Quiling, please send rescue assistance.`,
    `May nahihirapang huminga sa Poblacion Barangay 1, kapal ng abo eh, kailangan ng lunas agad.`,
    `BL0CK3D d4An sA Poblacion Barangay 6 dHl sA ABo!!! pLs h3lp`,
    `s4f3 n4 b4 bum4l1k s4 Barangay Tumaway??? aBo p4 r1n 😭`,
    `Residents in Banga need potable water because the local supply is contaminated by ash.`,
    `Guys may tumaob na bangka sa Taal Lake malapit sa riles papuntang Sta. Maria, please send help, wala pang response sa report ko sa Brgy Buco.`,
    `Gano po katagal pa ang class suspension dine sa Brgy. Balas, may text update na po ba?`,
    `HELPPP! yung tatay ko hirap huminga gawa ng chest pain nya need napo ng ambulansya asap malapit sa covered court sa Barangay Aya😭`,
    `TULONGGG POOO!! Paki evacuate po kame Lampas tao na po ang tubig baha plsss 😭😭`,
    `hlp us pls nasa rooftop kmi ngaun tumataas pa tubig d2 sa Poblacion 1 wlang bangka dumaan 😭`,
    `Salamat po sa relief goods kahapon, malaking tulong po ito para sa amin ng pamilya koo`,
    `May nanganganak napo dito yung asawa ng kapitbahay namin wla silang masakyan papunta ospital dito sa Brgy Banga`,
    `nlubog n bhay nmin d2 sa Balas hangang leeg n tubig, d na kmi mkalabas!!`,
    `konti n lng tubig nmin sana may dagdag n malinis n inumin bago gumabi Brgy caloocan`,
    `gutom n gutom n po kmi d2 sa health center wla p pong dumarating n relief truck.`,
    `check up lng po sana my allergy reaction kc bunso ko sa pagkain d2 sa relief goods Brgy Poblacion 3`,
    `sana lagi n lng ganito kabilis response nyo salamat MDRRMO Talisay 🙏🙏`,
    `bara n po kanal nmin kaya mabilis bumabaha kht di malakas ulan.`,
    `May himatayin pong lola dito sa evacuation center malapit sa boundary ng Leynes, mukhang stroke po, need ng medic ngayon din.`,
    `Nasira po ang tulay malapit sa covered court, hindi na po makadaan ang mga sasakyan`,
    `Ala eh natabunan ng lupa ang buong daan papuntang covered court, wala nang madadaanang sasakyan, Brgy Poblacion 1`,
    `Padine po kayo, nanganganak na si manang dine sa amin, wala kaming sasakyan papuntang ospital`,
    `The bridge going to Miranda has partially collapsed due to strong currents, and vehicles can no longer pass.`,
    `kelan po b susunod n weather update para samin d2 sa Brgy Quiling`,
    `Pls help po, stranded na kami dito sa house malapit palengke ng Brgy Poblacion 7! kase high tide na`,
    `Thank you for yesterday's relief distribution, it was a huge help for our family here.`,
    `Gano po kalayo pa ang rescue boat, dine kami sa may boundary ng sampaloc`,
    `proud ako sa mga kabataan ng Brgy Poblacion 4 tumulong mag pack ng relief goods kagabi 💪`,
    `MAY MALAKING BITAK SA LUPA MALAPIT SA tulay papuntang Sampaloc NATATAKOT KMI BAKA LUMALA PA BRGY San Guillermo`,
    `Paano po mag-request ng dagdag na pagkain para sa mga bata dito sa center, malapit sa Taal Lake shoreline ng Brgy Caloocan`,
    `need po formula milk agad wla po kming stock d2 sa center Brgy Tranca`,
    `bumagsak bubong nmin sa lakas ng hangin kagabi Brgy Tranca sana matulungan kming magpaayos`,
    `When can we expect the water line near Tumaway barangay hall to be repaired?`,
    `guys wla n signal d2 sa Poblacion 2 mahigit isang araw n simula nung bagyo kagabi`,
    `hi po ask ko lng kung san po pwd magdonate ng relief goods para sa Brgy San Guillermo`,
    `konti n lng tubig nmin sana may dagdag n malinis n inumin bago gumabi dito sa Brgy Poblacion 8`,
    `URGENT!! Baka may pwedeng magpadala ng potable water dine sa evacuation center sa Poblacion 5.`,
    `May residents na stranded sa Quiling, please send rescue assistance.`,
    `May nahihirapang huminga sa Poblacion 6, kapal ng abo eh, kailangan ng lunas agad.`,
    `HIRAP HUMINGA D2 Poblacion Barangay 3 dhl sA aBo!!! NEED MEDIC PLS ASAP!!! 😭😭`,
    `BL0CK3D d4An sA Poblacion Barangay 6 dHl sA ABo!!! pLs h3lp`,
    `s4f3 n4 b4 bum4l1k s4 Barangay Tumaway??? aBo p4 r1n 😭`,
    `Residents in Banga need potable water because the local supply is contaminated by ash.`,
    `Pwede na bang bumalik sa Barangay Tranca, o delikado pa dahil sa abo?`,
    `sAn EVAC cEntEr n3Ar Leynes??? pLS hELP ASAP!!!`,
    `Where is the nearest evacuation center for residents of Banga?`,
    `May nahihirapang huminga sa Brgy. 3 dahil sa ashfall, need po ng medical help.`,
    `Pwede na bang bumalik sa Kiling, o delikado pa dahil sa abo?`,
    `Saan kaya ang evacuation center na malapit sa Brgy. Leynes?`,
    `h1R4p hUm1ng4 sA Poblacion 4 dHl sA aBo 😭 nEed m3d1c pLs!!!`,
    `check up lng po sana my allergy reaction kc bunso ko sa pagkain d2 sa relief goods Brgy Sta. Maria`,
    `Salamat po sa medical team na dumalaw kagabi, gumaling na po ang lagnat ng bata namin, Brgy Balas.`,
    `Salamat po sa medical mission kahapon, malaking tulong po ito para sa mga may sakit dito, Brgy. Poblacion 7.`,
    `sana marami pang tumulong parang kanina, galing pa kabilang bayan, Brgy San Guillermo.`,
    `Marami pong senior citizens dito na wala nang makain mula kagabi, malapit sa Taal Lake shoreline.`,
    `Ilang araw na pong walang kuryente dito sa bangketa malapit sa simbahan, apektado na rin ang water pump ng barangay Pob 7.`,
    `kelan po kaya maaayos linya ng kuryente d2 samin puro ilaw kandila gamit namin Brgy Poblacion 5`,
    `HELPPP yuung tatay ko ay nahihirapan huminga gawa chest pain need napo ambulansya asap Brgy Buco malapit sa tulay papuntang Sampaloc 😭`,
    `Kailangan po ng bangka para sa mga pamilyang naipit sa baha malapit sa tulay papuntang Sampaloc at sa Brgy. Poblacion 2.`,
    `natumba ung malaking puno kasama poste sa may boundary ng Laurel blocked n daan papuntang Poblacion 1`,
    `thank u po sa mga volunteers galing pa ibang bayan at Barangay na tumulong d2 samin Brgy Caloocan 😊`,
    `Padine ho kayo at kailangan ho namin gatas para kay bunso, ala eh kahapon pa ubos ang stock namin dine sa evac center sa Quiling eh`,
    `Magandang umaga po, gusto ko lang po itanong kung ligtas na bumalik sa bahay sa Brgy. Quiling?`,
    `Naiwan po yung maintenance meds ni lolo sa bahang bahay namin, need na ma-refill po asap, kasd heart patient po siya doon po sa Brgy Banga bahay namin`,
    `Salamat po sa patuloy na suporta ng munisipyo sa amin dito sa Brgy. Sampaloc.`,
    `kelan po kaya maaayos linya ng kuryente d2 samin puro ilaw kandila gamit namin Brgy Caloocan`,
    `Magandang araw po, gusto ko lang pasalamatan ang mga barangay officials ng Poblacion 7 sa mabilis na aksyon.`,
    `Meron na po bang update kung kailan darating ang water refilling truck?`,
    `Ala eh nabagsakan po ng puno ang bubong namin dine sa Sta. Maria, paki puntahan niyo naman po.`,
    `May himatayin pong lola dito sa evacuation center malapit sa evacuation center sa gym, mukhang stroke po, need na ng medic ngayon`,
    `Salamat po sa mga naghatid ng gamot kahapon, gumaling na po ang lagnat ng apo ko, Brgy Poblacion 7.`,
    `kelan po b susunod n weather update para samin d2 sa Brgy Miranda`,
    `Naiwan po yung maintenance meds ni mama sa nabahang bahay namin, need ma-refill asap, diabetic patient po siya, taga Brgy San Guillermo po kame.`,
    `hi po ask ko lng kung san po pwd magdonate ng relief goods para sa Brgy Poblacion 8`,
    `thank u po sa mga volunteers galing pa ibang bayan tumulong d2 samin Brgy Quiling 😊`,
    `Medyo nasira ang bubong ng health center dahil sa malakas na hangin, Brgy Sampaloc.`,
    `Naputol ang linya ng tubig papunta sa amin matapos masira ang pipeline malapit sa palengke ng Brgy Sta. Maria.`,
    `Nadikit na po ang tubig sa bubong namin dine sa evacuation center sa gym, Brgy Caloocan, di kami marunong lumangoy walanya`,
    `Ala eh tulong naman po! Natabunan na ang daan sa Brgy. Buco gawa ng landslide, di makadaan ang ambulansya!`,
    `wla n daan papuntang Banga natabunan ng lupa may naiipit daw sa loob ng kotse pki tulungan`,
    `Sun0G poH D2 pOB 1 Bc0z ng k1dL4t k4g4b1h, pLS 53ND BUMbERO`,
    `Naaamoy po namin ang usok mula sa Poblacion 1, natatakot kami baka kumalat pa ang apoy.`,
    `F1r3 n4 N4M4N sA Brgy 1 dHl sA kUrY3nT3!!! h3lp pLs",`,
    `May grassfire na kumakalat malapit sa Poblacion 1 dahil sa dry season after ng bagyo, pls send bumbero.`,
    `Grabe, kumalat na ang apoy sa damuhan malapit sa Poblacion Barangay 1 dahil sa tuyot na lupa, e.`,
    `saan po dito may sabungan sa Sampaloc?`,
    `sunog po dito sa tumaway at dalawang bahay na po ang natupok ng apoy `,
    `stranded kami dito sa Brgy Miranda, 6 pamilya, wala kaming paraan na makalabas pls help`,
    `hlp po s Brgy Leynes may nsa bubong n pamilya d2 3 oras na wlang rescue!!!`,
    `grabe tlga ang baha d2 s Brgy Cawit  nasa bubong n kmi 😭😭`,
    `may lindol dito sa Brgy Sampaloc biglang bumagsak ang pader ng kapitbahay namin, may nasugatan na residente tulong po`,
    `gRaBe p0 yUnG lAkAs nYa mArAmInG bAhAy nAsIrA n pLs hElP!!!`,
    `OMG L1ND0L P0 D2 SA BRGY TUMAWAY GRABE ANG LAKAS NYA HINDI NA KAMI MAKALABAS NG BAHAY PLS HELP 😱😱`,
    `Bes grabe yung lindol kanina sa Brgy Leynes nahulog lahat ng gamit namin sa bahay char pero totoo delikado na`,
    `L1nd0l d2 brgy pob 3!!! mrming bhay nsra nd2 pls snd rscue ASAP!!!`,
    `Grabe na ang baha dito sa Leynes halos tuhod na ang tubig sa loob ng bahay namin kailan darating ang rescue`,
    `Ateh yung baha sa Brgy Cawit ay grabe na talaga parang dagat na ang kalsada namin dito puro tubig`,
    `Reported landslide incident in Barangay Tumaway blocking the main road. Several families are trapped and need immediate assistance`,
    `Grabe yung bagyo kanina sa Brgy Leynes maraming bahay ang nawasak kailan darating ang relief goods`,
    `grbe gho lpa d2 brgy qling pti bhay nmin natmaan need hlp ASAP!!!`,
    ` s4f3 n4 b4 bUm4l1k s4 bRgY qU1l1nG??? mAy L1nD0l p4 r1n d4w 😭😭`,
    `Reported severe flooding in Barangay Buco water level has reached roof level and we need rescue operations urgently `,
    `bhy0 d2 brgy leynes nwsk na lahat grbe yng hngn pls snd hlp`,
    `Tulong po, may gumuhong lupa dito sa Barangay Sampaloc`,
    `Wala po bang tulong dine sa tumaway kailangan po namin maka lipat ng evacuation center`,
    `Mayroon pong gumuhong lupa dito sa Poblacion 1 at may taong natabunan, kailangan po namin ng tulong nyo ngayon para mahukay yung tao`,
    `Magandang umaga po may gumuhong gusali po dito sa Poblacion 2 at kasalukuyang hinaharangan po ang kalsadsa`,
    `Baka naman po makakarespond agad kayo gawa ng may tumumbang poste ng kuryente dito sa Barangay Banga at nag lawit po ang kable ng kuryente`,
    `Need po namin agarang tulong dito sa Barangay Caloocan gawa ng may na trapped po na bata dito sa gumuhong bahay`,
    `Magandang gabi, pwede po ba kayo magpadala ng tao dito sa Barangay Sampaloc, malapit po sa highway para po maalis namin ang mga bato na nanggaling sa landslide`,
    `walangya kanina pa kame nahinge ng tulong dito sa tumaway gawa ng pagputok ng bulkang taal, bakit wala parin narespond sa inyo? `,
    `nawawala po yung kapatid ko tinangay daw po ng bahay dito sa tranca, kanina pa po namin hinahanap pero hindi namin makita tulong po!!!!!`,
    `tulong po nabagsakan po ng pader yung kapatid dahil sa lindol, malapit po kame eskwelahan sa quiling`,
    `kumakapal na po yung hamog dito sa barangay miranda at baka po makakapagpadala kayo tao gawa hindi ko malabas magisa yung lumpong magulang ko`,
    `saan po kaya pwedeng mag evacuate dito sa quiling?`,
    `waaah help!!!! mEy nAaNoD sA iLoG sA qUiling!!!!! tulooong!!!!`,
    `kailan po kaya titigil ang pagulan?`,
    `magpadala na po kayo ng bangka dine sa tranca at walangya gatao na ang baha `,
    `urgent po need po namin ng responder dito sa tranca dahil gumuho po yung lupa sa paahon dito at may mga bahay  na natabunan`,
    `mahamog na po dito sa Sampaloc gawa ng buga ng usok ng taal baka naman po may supplies kayo na maibibigay samen`,
    `saklolo po may nasusunog at na bahay dito sa buco at naiwan po yung dalawang bata sa loob, bilisan nyo po at mabilis nakalat ang apoy`,
    `aba'y abot tao na ang baha ayaw ninyo parin kumilos`,
    `kanina pako nag aantay ng rescue dito sa cawit hanggang bubong na ang baha bakit wala padin kayo? babarilin ko na kayo`,
    `grabe ang abo dito dine leynes hindi na namen makita ang langit, baka naman matutulungan nyo kameng lumikas`,
    `pwede po bang huminge ng tulong? magpapa rescue po kame dito sa balas gawa ng hindi po kame makalabas dahil natabunan ng lupa yung daanan palabas`,
    `2long po sobrang lakas na po ng buga ng usok ng taal, baka po may mga supplies kayo na pedeng ipamigay dito sa Barangay Sampaloc`,
    `baka po makakapagpadala kayo ng mga tauhan para alisin yung mga batong nasa kalsada dahil sa landslide, nagt-traffic na po dito at gusto ko na tsumibog`,
    `makapal na ang abo sa kalsada dito sa aya, linisin nyo nga to `,
    `ubos na po ang pagkain namin dito sa bahay at tatlong araw na din walang tigil ang bagyo, kailan ba kayo magpapadala ng supply dito sa banga? mamamatay na kame kakaantay `,
    `need po namin ng medical supply nadale po ng lumipad na yero ang tatay ko at malalim po ngayon ang sugat`,
    `!!!tulong po tumataas na ang baha dito sa tranca nasa bubong na po kame ng bahay pero patuloy padin po ang pagtaas `,
    `tatlong araw na hindi tumutigil ang ulan, maghanda na kyo ng food supplies at madameng pamilya dito sa caloocan ang nagugutom`,
    `hoy!!! kailan kayo magpapadala ng tao dito sa miranda? abay nakalat na ang apoy sa mga bahay bahay. Aantayin nyo pa ba na madaming bahay ang madamay `,
    `may bata pong nabangga dito sa highway sa sta. maria, antatanga pa ng mga tao walang nahingi ng saklolo, kaya kayo na ang pumunta dine walangya `,
    `tulong po natabunan ng lupa galing sa landslide yung kapatid ko, taga leynes po kame `,
    `palagi na lang gatao ang baha tuwing umuulan dito sa tranca`,
    `stay safe po kayo nagaaburuto po ang taal`,
    `tulong po may tinamaan ng yero lumilipad dito sa balas, mukhang maluha po ang kalagayan niya`,
    `may dalawang kotse po ang nagsalpukan dito sa san guillermo kritikal po yung kalagayan ng isa`,
    `grabe ang lakas ng lindol may gumuhong bahay dito sa quiling !!!! pero buti naman walang nasaktan `,
    `baka po makakahingi kayo ng tulong para maayos natumbang poste sa kalsada dito miranda, naglawit po kase yung kable ng kuryente baka may makuryente dine `,
    `sobrang lakas ng hangin dito sa tumaway, nagliliparan ang mga yero ng mga bahay!!!! magiingat po kayo`,
    `saan po makakahingi ng gamot dito sa poblacion 3? ubos na po ang supply sa drug store at 2 araw na po inaapoy ng lagnat ang anak ko!!!`,
    `naramdaman nyo din ba yung lindol??? walangya ang lakas nahulog mga gamit sa bahay!!! ###stay safe`,
    `when po kaya dadating ang mga relief goods sa sampaloc? gutom na po ako umaga pako hindi nakain!!!`,
    `pls help!!!! inaanod po baha yung kapatid ko, hindi po kame makasunod at sobrang lakas po ng baha at gatao na. sana po makarespond kayo agad `,
    `salamat po dumating na po yung relief goods dito sa poblacion 6!!! pagpalain po sana kyo ng panginoon`,
    `panginoon ingatan mo po kame lalo na't may malakas bagyo na tatama sa talisay`,
    `salamat po sa pagrescue samen, nandito na po kame sa evacuation center sa leynes!!! maraming salamat po uli `,
    `may mga extrang supply ba kayo dyan? kakaunti lang kaseng gamit ang nasalba namin sa baha. Nandito po sa elementary school sa quiling dito po kame nag evacuate`,
    `dalawang bahay na po ang natupok ng aboy dine sa sta maria, wla pading bumberong dumadating`,
    `kumain na po ba kayo?`,
    `tulong po may tanong ako sa assignment ko!!!!`,
    `wag po muna kayong maglalabas ng bahay at sobrang lakas hangin maraming yero ang naglilipadan!!!!`,
    `nagkaroon ng sunog dito sa tranca pero buti naman naapula naman agad `,
    `maraming salamat po mdrrmo sa pagtulong na mahanap ang kapatid ko natabunan ng lupa `,
    `pinasok na ng baha ang bahay namin, ilaan nyo naman ng maayos ang budget nyo sa flood control!!!`,
    `anlakas po ng lindol po kanina sa brgy leynes grabe talaga yung lakas parang ayaw na tumigil ng yanig sana po maging maayos na ang lahat and stay safe kayo!!!`,
    `need po namin ng rescue dito sa leynes, anlakas parin ng ulan at mukang malapit na pong gumuho yung lupa sa taas dito`,
    `magiingat po kayo sa kalsada papuntang quiling, yung lupa po sa kilid ng kalsada mukang malambot na at malapit ng gumuho`,
    `magandang umaga po need po namin ng mga tauhan nyo dito sa balas para po maalis namin yung posteng natumba gawa ng bagyo, mas ok po kung makakapag padala na kayo agad ng mga tao!!!`,
    `sobrang lakas po ng hangin may nilipad na kahoy dito at tinamaan po yung kuya ko sa ulo, nagdurogo po ang ulo niya at need po namin ng medic ASAP taga miranda po kame`,
    `pwede pong magtanong? Never grow old?`,
    `walang relief goods buseng? abay tatlong araw na kame nagdi-dil sa asin dine sa Poblacion 7!!!!!`,
    `kailangan ga babalik ang kuryente? aba'y 1 linggo na walang tubeg ubos na din supply nameng tubig. baka naman makakapag provide kayo ng supply dine sa aya`,
    `thank you very much for the relief goods that was sent to the evacuation center in the Tumaway `,
    `tulong po may matandang nasagasaan dine sa highway sa balas, hindi ho kumikibo ang matanda!!!! magpadala na kayo ng ambulansya dine ASAP`,
    `hoy kailan kayo magrerespond sa tawag namin? maghapon na kame dineng trapped sa bubong ng bahay gawa baha. Aba kelan nyo kameng balak irescue? pag patay na? bilisan nyo dito kame sa tranca`,
    `salamat po sa water supply na ipinamigay dito sa san guillermo, maraming pamilya po ang natulungan`,
    `may mag-ina pong natrapped sa loob ng nasusunog na bahay dito sa banga, bilisan nyo po at mukang kulang ang bumberong pumunta dito`,
    `may extra po ba kayong bangka dyan? ililikas ko po sana ang lola kong lumpo dito, hindi na po kase siya nakakalakad taga miranda po kame malapit sa manggahan `,
    `ang tagal naman dumating ng responder nyo!!! ubos na ang yero ng mga bahay gawa ng bagyo !!! bilisan nyo madaming din pamilya nagaantay ng response dito sa tumaway`,
    `saan po kaya may barikan dito sa balas? gusto ko magwalwal`,
    `send help po dito sa balas may magasawang natangay po ng bahay, magingat po kayo at sobrang lakas ng agos ng baha!!!`,
    `safe na po kaya umuwi sa sari-sariling bahay? mukang tumugil na po ang bagyo eh `,
    `send help plss, urgent po tinamaan po ng ligaw na yero ang bunso kong kapatid at sobrang lakas po ng bleeding ng hiwa sa likod niya`,
    `jusko po nabagsakan ng pader yung kapitbahay namin dito sa banga need po namin ng assistance niyo kase wala pong response yung tao eh `,
    `irescue nyo pa po yung mga bata dito sa sampaloc at sobrang kapal na po ng abo dine. baka magkasakit pa ang mga bata dine`,
    `help po need namin ng medic may babae pong nabangga ng truck dine sa balas at madami pong mga establishment ang nadamay at nasugatan`,
    `can you send responders here in poblacin 4 to rescue us? we've been stuck inside our house because the mud from landslide is blocking our way out and we are now starting to get hungry and we are out of supply now`,
    `hlp myrng tatlong sgtn dto s tmwy dhl s lndslde, klgn nmn ng medical n tlong`,
    `magpadala po kayo ng mga tauhan dito sa banga para irescue yung mga pamilyang hindi po makalikas dahil sa baha, andame na po namin ditong nagaantay sa taas ng bubong at nagaantay ng tulong `,
    `may punong pong natumba dito sa kalsada sa sampaloc, buti naman naman walang nasaktan pero nakaharang po ang puno sa kalsada ngayon at nagdudulot ng traffic kaya need po namin ng tulong nyo`,
    `ang kapal ng asupre dine sa pob 3 ang bagal nyo mag linis pakibilisan naman`,
    `ang lakas ng hangin pa rescue po kami dito sa poblacion 1`,
    `magandang araw kailangan po namin supply ng diaper dine sa balas kakaawa po mga bata ditong maliliit`,
    `wala pong supply ng tubig dito sa 3 putol lahat ng linya`,
    `wala pong power dito sa 5 putol mga linya`,
    `wala pong madaana dito sa balas bitak bitak mga karsada`,
    `putol po tulay dito sa miranda hindi kami makapamili ng makakain`,
    `ang bagal po ng rescue nyo sa totoo lamang ho`,
    `bakit naman puro bigas wala manlang ulam na bigay dito sa brgy aya suskopo`,
    `ano pong magandang camera pang vlog ng mga kurap`,
    `pwede po ba pati mga alaga naming hayop pa rescue po? pakiusap po dine sa barangay aya lang naman ho`,
    `ang lakas ng lindol tumbahan mga poste nakakatakot`,
    `saan po pwede lumikas mga nasiraan ng bahay dahil sa lakas ng bagyo ? pls reply po`,
    `saan napo ang mdrrmc team pakiusap po nataas na tubig sa lawa ng taal`,
    `sobrang lakas ng hangin liparan mga bubong namin sana ma rescue kaming mga taga brgy 7`,
    `ang kapal pa ng abo dine sa tranca di na makahinga mga bata sana may mask man lang po`,
    `baha na po lagpas tao na dine sa poblacion 2 paki rescue po kami may matanda po kaming kasama`,
    `lakas ng lindol kanina dine sa buhangin may bitak na pader namin nakakatakot na matulog ho`,
    `gumuho po lupa dito sa may quiling hindi na madaanan ng tricycle barado na po ng putik`,
    `may sunog po sa may damuhan malapit sa banga amoy usok na po dine sa amin baka kumalat pa`,
    `wala pa din pong tubig dito sa sanura dalawang araw na po kami walang ligo pati inumin wala`,
    `bagal naman ng ayuda dito sa aya puro lista lang wala namang dumadating na tulong ho totoo lang`,
    `may alam po ba kayong bilihan ng powerbank dito sa talisay lobat na po lahat ng cp namin`,
    `saan po pwede mag evacuate taga miranda po kami taas na po tubig sa may tulay di na makatawid`,
    `grabe hangin kagabi liparan bubong ng kapitbahay namin dito sa poblacion 7 tulong po paki rescue`,
    `ang lakas ng bagyo dito sa poblacion 5 lipad na po yero namin wala na kaming masilungan ho`,
    `paki rescue po kami dito sa aya may baby po kaming kasama baka liparin na bubong namin sa hangin`,
    `wala pong kuryente dito sa balas simula pa kagabi dahil sa bagyo lobat na po lahat ng cp namin`,
    `saan po pwede lumikas taga miranda po kami binabaha na po kami sa lakas ng ulan ng bagyo`,
    `kailangan po namin ng tubig at bigas dito sa tranca naubos na po stock namin dahil sa bagyo`,
    `may natumbang puno po dito sa banga harang po sa daan hindi makadaan ang rescue`,
    `pwede po ba makahingi ng diaper at gatas dito sa buhangin may baby po kami stranded sa bagyo`,
    `may senior po dito sa quiling kailangan po ng gamot pang highblood naipit po dahil sa bagyo`,
    `pakiusap po pati mga alaga naming aso dito sa sampaloc wala na pong silungan sa lakas ng bagyo`,
    `grabe po hangin dito sa tumaway natatakot po mga bata baka matuklap bubong namin tulong po`,
    `grabe bahang baha puro kase kurap mga naka upo sulit budget ng flood control ah`,
    `kung di nyo sana binulsa pera pang flood control edi sana lahat tayo happy kahit may bagyo!!`,
    `grabe yung lindol sira sira pati mga kalsada, sana maaksyonan agad `,
    `pa rescue po ng mga nawawala dito samin sa tranca, hindi parin po mahanap yung matandang inanod ng baha`,
    `pa rescue po ng mga nawawala dito samin sa tranca, hindi parin po mahanap yung matandang natabunan ng lupa`,
    `pa rescue naman po kami dito sa tranca sobrang lakas po ng hangin hindi nag liliparan na mga yero namin`,
    `sobrang kapal na ng abo wala parin na rescue samin ano ba naman yan`,
    `Diyos ko po ang lakas ng lindol dito sa buhangin gumagalaw po lupa nahulog lahat ng gamit namin`,
    `yumanig na naman po ng malakas dito sa caloocan may bitak na po pader namin takot na takot mga bata di makatulog`,
    `ang lakas po ng lindol kanina sa aya tumbahan po mga poste at pader nakakatakot lumabas baka may aftershock pa`,
    `Lord parang mahihilo na po kami sa kakayanig dito sa sta maria may malaki na pong bitak kalsada sa amin`,
    `lumindol na naman po dito sa quiling may bitak na po sahig namin saan po kami tatakbo pag lumakas pa`,
    `grabe yung lindol sira sira na po kalsada dito sa tumaway pati bahay namin may crack na paki check naman po`,
    `nakakatakot na po matulog dito sa banga lakas ng lindol kanina may nahulog na pong kisame sa kwarto ng anak ko`,
    `ayan na naman po lumindol na naman dito sa leynes ang lakas po Diyos ko po sana matapos na to`,
    `may malaking bitak na po lupa dito sa san guillermo delikado na po baka biglang gumuho bahay namin tulong po`,
    `may sunog po sa may damuhan sa sampaloc ang bilis kumalat dahil sa hangin amoy usok na po dine sa amin`,
    `tulong po may nasusunog na talahiban dito sa banga malapit na po sa bahay namin baka abutin kami`,
    `grabe po usok dito sa tranca may sunog po yata sa may bukid hindi po makahinga mga bata`,
    ` may sunog po sa may poblacion 6 malapit sa palengke ang bilis po ng apoy dahil sa hangin paki rescue po bumbero`,
    `Diyos ko po may nagliliyab na po sa may buhangin ang lakas ng apoy natatakot po kami baka kumalat sa bahay`,
    `amoy sunog na po dito sa aya may grassfire po yata sa may taas ng bundok kita po usok dito sa baba`,
    `sunog po sa may basurahan sa caloocan kumakalat na po usok ang baho na po hindi na makahinga mga bata`,
    `may sumiklab po na apoy dito sa quiling galing po sa naputol na kuryente dahil sa bagyo delikado po`,
    `tulong po may sunog po sa may balete malapit sa sta maria ang bilis kumalat sa damuhan sana may bumbero na`,
    `baha na po lagpas tao na dine sa poblacion 2 paki rescue po kami may matanda po kaming hindi makalakad`,
    `taas na po tubig ng lawa ng taal dito sa leynes abot na po sa loob ng bahay namin saan po kami lilikas`,
    `grabe na po baha dito sa san guillermo lagpas dibdib na po hindi na po makalabas mga bata at senior`,
    `putol na po tulay sa miranda dahil sa baha hindi na po kami makatawid para bumili ng pagkain at gamot`,
    `pa rescue po ng mga nawawala dito samin sa tranca hindi pa rin po mahanap yung matandang inanod ng baha kahapon`,
    `lubog na po buong bahay namin dito sa poblacion 3 hanggang bubong na po tubig tulong po`,
    `ang bilis po ng ragasa ng tubig dito sa tumaway galing sa bundok pumasok na po sa bahay namin`,
    `baha na po dito sa sampaloc pati mga manok namin inanod na po wala na po kaming kabuhayan`,
    `sana humupa na baha dito sa balis? sa balas pala lagpas tuhod na po wala pa pong rescue`,
    `gumuho na po lupa dito sa quiling barado na po daan hindi na makadaan pati tricycle at ambulance`,
    `pa rescue po ng nawawala dito samin sa tranca hindi pa rin po mahanap yung matandang natabunan ng lupa`,
    `may landslide po dito sa buhangin natabunan na po bahay ng kapitbahay namin kailangan po ng rescue agad`,
    `grabe po putik at bato dito sa tumaway galing sa guho sa taas hindi na po madaanan kalsada`,
    `natabunan na po ng lupa bahay ng tita ko dito sa san guillermo kailangan po ng tulong para mahukay`,
    `ang dulas na po ng daan dito sa caloocan dahil sa putik galing sa landslide baka may madisgrasya pa`,
    `may malaking guho po dito sa leynes malapit sa lawa delikado na po baka may matabunan pa na bahay`,
    `gumuho na po riprap dito sa tranca papuntang tagaytay ridge hindi na po madaanan takot na kami`,
    `huhuhu ang kapal ng abo dine sa tranca parang ulap na itim di na makahinga mga anak ko may mask po ba kayo`,
    `grabe lakas ng hangin dito sa poblacion 1 nilipad na buong bubong ng kapitbahay namin takot na takot kami`,
    `pakiusap po sino may extra diaper at gatas dine sa balas kawawa na mga baby namin iyak na ng iyak sa bagyo`,
    `tatlong araw na pong walang tubig dito sa poblacion 3 putol lahat ng linya pati pang hugas wala na`,
    `brownout pa din po dito sa poblacion 5 simula pa kagabi dahil sa bagyo wala na kaming charge`,
    `hindi na po madaanan kalsada dito sa buhangin ang lalaki ng bitak dahil sa lindol delikado po`,
    `putol na po tulay sa miranda hindi na po kami makatawid para bumili ng pagkain gutom na pamilya ko`,
    `ano ba naman kayo ang bagal ng rescue nyo dito sa aya kanina pa kami tawag ng tawag ho totoo lang`,
    `suskopo puro bigas lang binigay dito sa aya paano naman ulam ng mga bata wala man lang sardinas`,
    `sorry po out of topic pero ano po magandang powerbank pang brownout palagi kasi wala kuryente`,
    `pwede po ba isama pati mga aso at pusa namin sa rescue dine sa banga ayaw po namin sila iwan sa baha`,
    `yumanig na naman po ng malakas nakakatakot na tumbahan na po mga poste dito sa caloocan`,
    `saan po kami pwede lumikas taga poblacion 2 po kami sira na bahay namin sa lakas ng bagyo pls reply`,
    `saan na po mdrrmc team pakiusap po tumataas na tubig ng lawa ng taal dito sa leynes abot na sa amin`,
    `liparan na po mga bubong dito sa poblacion 7 sobrang lakas ng hangin sana po may mag rescue sa amin`,
    `ang kati na po ng abo sa mata at lalamunan dine sa poblacion 3 wala man lang naglilinis ng kalsada ho`,
    `baha na po lagpas bewang na dine sa poblacion 2 may matanda po kaming kasama hindi makalakad paki rescue`,
    `kanina pa po lumindol dito sa buhangin may bitak na po pader namin di na kami makatulog sa takot`,
    `gumuho na po lupa dito sa quiling barado na po daan hindi na makadaan tricycle namin pati motor`,
    `may sunog po sa may damuhan sa banga kumakalat na po amoy usok na dito sa amin baka abutin bahay`,
    `dalawang araw na po kaming walang tubig dito sa sta maria pati pang inom wala na po`,
    `puro lista lang po ginagawa dito sa aya wala naman dumarating na ayuda nakakainis na po ho`,
    `may alam po ba kayo bilihan ng load dito sa talisay wala po kasi signal smart at globe simula bagyo`,
    `hindi na po kami makatawid sa tulay ng miranda mataas na po tubig sa ilog sana po may bangka`,
    `kagabi pa po liparan yero ng kapitbahay namin dito sa poblacion 7 hindi po kami nakatulog sa takot`,
    `dine sa poblacion 5 wala na po kaming masilungan nilipad na po bubong namin sa lakas ng hangin`,
    `pakiusap po may baby po kami dito sa aya baka po liparin na bubong namin sa lakas ng bagyo tulong`,
    `wala na po kuryente dito sa balas simula pa kagabi dahil sa bagyo lobat na po lahat ng cp namin`,
    `saan po kami lilikas taga miranda po kami binabaha na po kami dahil sa lakas ng ulan ng bagyo`,
    `naubos na po bigas at tubig namin dito sa tranca dahil sa bagyo may bata pa naman po kami`,
    `may natumbang puno po dito sa banga harang sa daan hindi po makadaan rescue po sana maalis`,
    `wala na pong gatas at diaper baby namin dito sa buhangin stranded po kami dahil sa bagyo huhuhu`,
    `may senior po dito sa quiling kailangan po ng gamot pang highblood naipit po dahil sa bagyo`,
    `kawawa naman po mga aso namin dito sa sampaloc wala na pong silungan sa lakas ng bagyo at ulan`,
    `grabe po hangin dito sa tumaway umiiyak na po mga bata natatakot baka matuklap bubong namin`,
    `sabi nyo may flood control project dito sa leynes pero bakit baha pa din tuwing may bagyo grabe kurap`,
    `kung hindi nyo binulsa pondo ng flood control edi sana hindi kami lumulubog dito sa poblacion 6`,
    `ang baho na po ng putik dine sa caloocan galing sa guho wala pa din po naglilinis isang linggo na`,
    `pakiusap po may buntis po dito sa san guillermo kailangan po namin ng rescue mataas na po baha`,
    `wala na po kaming makain dito sa poblacion 8 tatlong araw na po walang ayuda dahil sa bagyo`,
    `ang lakas pa din po ng lindol dito sa sta maria parang nahihilo na po kami sa yanig`,
    `sunog po yata sa may sampaloc malapit sa palayan ang bilis kumalat dahil sa hangin tulong po`,
    `pwede po ba makahingi ng kumot at banig dito sa poblacion 1 basa na po lahat ng gamit namin sa baha`,
    `saan po may libreng charging dito sa talisay wala na po kaming baterya simula nung bagyo pa`,
    `natabunan na po ng lupa bahay ng tita ko dito sa quiling kailangan po ng rescue please po`,
    `ang sakit na po sa mata ng asupre dine sa poblacion 4 wala man lang abiso kung safe pa lumabas`,
    `huhuhu wala na po kaming bubong dito sa leynes nilipad po lahat ng yero kagabi sa bagyo`,
    `puro kayo picture sa ayuda pero wala naman po napupunta dito sa buhangin gutom na po kami`,
    `may landslide po ulit dito sa tranca malapit sa lawa delikado na po daan baka may matabunan`,
    `kailangan po namin ng flashlight at baterya dito sa tumaway brownout pa din po simula bagyo`,
    `ang ingay na po ng bubong namin dito sa poblacion 6 parang matatanggal na sa lakas ng hangin`,
    `saan po may evacuation center na pwede magdala ng alagang hayop taga aya po kami`,
    `grabe na po baha dito sa san guillermo lagpas dibdib na po hindi na po makalabas mga bata`,
    `wala man lang po dumaan na mdrrmc dito sa sta maria maghapon na po kaming naghihintay sa baha`,
    `ang dami na pong bitak ng lupa dito sa caloocan dahil sa lindol baka gumuho na po bahay namin`,
    `pakiusap po yung mga senior dito sa poblacion 4 wala na pong gamot at pagkain simula pa kahapon`,
    `nakakainis na po puro pangako lang ginagawa nyo tuwing may bagyo wala namang aksyon talaga`,
    `may baby po kami dito sa leynes nilalagnat na po dahil nabasa ng ulan sa bagyo kailangan ng gamot`,
    `saan po nakakabili ng yero dito sa talisay nasira po bubong namin sa bagyo wala pa pong tulong`,
    `bakit po hanggang ngayon wala pa din pong tubig dito sa poblacion 2 ang dumi na po namin`
];

const SYSTEM_INSTRUCTION = `You are an expert NLP data annotator for 'Responde', an emergency response system in Talisay, Batangas, Philippines.
You analyze incoming messages in Tagalog, English, Taglish, and Batangas dialect (e.g., using "dine" for "dito", "ga", etc.).

For each text, you must output a structured JSON object with:
1. "intent": Exactly one of:
   - "EMERGENCY_REPORT" (Active danger, rising flood waters, active fire, entrapment, immediate threat to life or property)
   - "RESOURCE_REQUEST" (Asking for food, potable water, relief packs, evacuation shelter, rescue boats, supplies, medicine, repair materials)
   - "STATUS_INQUIRY" (Asking for updates on water level, typhoon signal, alert level, road passability, rescue ETA, safe to return)
   - "CASUALTY_REPORT" (Specifically reporting dead, injured, wounded, missing persons, or giving birth / stroke / chest pain in disaster)
   - "CASUAL_OR_GREETING" (Greetings, "Hello po", "Magandang umaga", "Musta", general questions, casual assignment/vlog inquiries)
   - "FEEDBACK_OR_THANKS" (Expressing gratitude, thanking responders, "Salamat po", "Maraming salamat", praises)
   - "OTHER" (Complaints about corruption/budget, spam, barikan/drinking questions, unclassifiable out-of-topic)

2. "urgency": Exactly one of:
   - "CRITICAL" (Immediate danger to life: drowning, active fire, trapped under debris/landslide, severe bleeding/casualty, chest pain, stroke, giving birth)
   - "HIGH" (Rising flood entering home, live wires down in water/road, approaching storm/fire, urgent resource need like infant milk/potable water, blocked roads)
   - "MEDIUM" (Needs food/clean water, stranded but safe, relief supply inquiries, power outage after storm)
   - "LOW" (Inquiries, greetings, gratitude, status checks, general chitchat, assignment questions)

3. "incident_type": Exactly one of the 7 core natural disaster hazard categories:
   ["earthquake", "fire", "flood", "landslide", "none", "typhoon", "volcanic_eruption"]
   Important rules:
   - "earthquake": lindol, yanig, nayanig, fissure, bitak sa lupa/kalsada dulot ng lindol.
   - "fire": sunog, apoy, nagliliyab, grassfire, talahiban.
   - "flood": baha, binaha, lumubog, inaanod ng baha, high tide baha, taas ng tubig.
   - "landslide": landslide, guho, pagguho, gumuho, natabunan ng lupa/putik, riprap collapse.
   - "typhoon": bagyo, malakas na hangin, liparan ang yero/bubong, natumbang puno/poste dahil sa hangin/bagyo.
   - "volcanic_eruption": abo, ashfall, asupre, buga ng usok ng taal, bulkang taal aburuto.
   - "none": if the message does not mention or stem from a specific natural disaster hazard (e.g. casual chitchat, ordinary car crash with no disaster context, general corruption complaint without disaster mention).

4. "barangay": The canonical name of the Talisay barangay mentioned, or "Unknown" if not in Talisay or not mentioned.
   Valid barangays: ${JSON.stringify(BARANGAYS)}
   Note: Map colloquial terms:
   - "Poblacion 1" / "pob 1" / "Brgy 1" -> "Poblacion Barangay 1"
   - "Poblacion 2" / "pob 2" -> "Poblacion Barangay 2"
   - "Poblacion 3" / "pob 3" / "Brgy. 3" -> "Poblacion Barangay 3"
   - "Poblacion 4" / "poblacin 4" -> "Poblacion Barangay 4"
   - "Poblacion 5" / "Brgy. 5" / "5" -> "Poblacion Barangay 5"
   - "Poblacion 6" -> "Poblacion Barangay 6"
   - "Poblacion 7" / "brgy 7" / "Pob 7" -> "Poblacion Barangay 7"
   - "Poblacion 8" -> "Poblacion Barangay 8"
   - "Sta. Maria" / "sta maria" -> "Santa Maria"
   - "Kiling" / "qling" / "quiling" -> "Quiling"
   - "tmwy" / "tumaway" -> "Tumaway"
   - "buhangin" / "sanura" / "Cawit" / "Laurel" -> If not one of the official 21 Talisay barangays, use "Unknown" or the matching official barangay if applicable.

5. "ner_spans": An array of extracted entities found verbatim in the text:
   Each entity is: { "text": string, "label": "LOCATION" | "INCIDENT" | "PERSON_NAME" | "CONTACT_NUMBER" }
   - "LOCATION": Specific place, street, landmark, or barangay text
   - "INCIDENT": Emergency event term verbatim in text (e.g., "lindol", "landslide", "sunog", "baha", "abo", "bagyo", "hangin", "natabunan ng lupa")
   - "PERSON_NAME": Names of people reported
   - "CONTACT_NUMBER": Phone numbers
`;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function csvEscape(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") val = JSON.stringify(val);
    const s = String(val).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

function toCSV(rows) {
    const headers = [
        "id",
        "source",
        "author",
        "text",
        "intent",
        "urgency",
        "incident_type",
        "barangay",
        "ner_spans",
        "timestamp"
    ];
    const lines = [headers.join(",")];
    for (const r of rows) {
        lines.push(headers.map(h => csvEscape(r[h])).join(","));
    }
    return lines.join("\n");
}

async function annotateBatch(batch) {
    const promptPayload = batch.map((item, idx) => ({
        index: idx,
        id: item.id,
        text: item.text
    }));

    const userPrompt = `Annotate the following array of records according to the instructions.
Return ONLY a valid JSON array of objects, each containing:
{
  "index": number,
  "id": string,
  "intent": string,
  "urgency": string,
  "incident_type": string,
  "barangay": string,
  "ner_spans": [ { "text": string, "label": string } ]
}

Input items:
${JSON.stringify(promptPayload, null, 2)}`;

    for (let attempt = 0; attempt < 30; attempt++) {
        let client, keyIndex;
        try {
            const keyInfo = geminiPool.getNextClient();
            client = keyInfo.client;
            keyIndex = keyInfo.keyIndex;
        } catch (poolErr) {
            console.warn(`⏳ Keys in cooldown. Waiting 15s...`);
            await sleep(15000);
            continue;
        }

        try {
            const response = await client.models.generateContent({
                model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
                contents: userPrompt,
                config: {
                    systemInstruction: SYSTEM_INSTRUCTION,
                    responseMimeType: "application/json",
                    temperature: 0.1
                }
            });

            const text = response.text?.trim() || "";
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error("Expected JSON array from Gemini.");
            return parsed;
        } catch (err) {
            const is429 = err.message?.includes("429") || err.status === 429;
            const is401 = err.message?.includes("401") || err.status === 401;
            if (is401) {
                geminiPool.markKeyCooldown(keyIndex, 24 * 60 * 60 * 1000);
            } else if (is429) {
                geminiPool.markKeyCooldown(keyIndex);
            } else {
                console.warn(`⚠️ Error on attempt ${attempt + 1}: ${err.message}`);
            }
            await sleep(1000);
        }
    }
    throw new Error("Failed to annotate batch after multiple attempts.");
}

async function main() {
    console.log(`Starting ingestion of ${RAW_MESSAGES.length} user synthetic messages...`);

    const rawRecords = RAW_MESSAGES.map((text, i) => {
        const hash = crypto.randomBytes(4).toString("hex");
        const now = new Date(Date.now() - Math.floor(Math.random() * 14 * 86400000));
        return {
            id: `synth_user_${hash}_${i + 1}`,
            source: "synthetic",
            author: "Resident of Talisay",
            timestamp: now.toISOString(),
            text: text.trim()
        };
    });

    const BATCH_SIZE = 10;
    const annotatedNewRecords = [];

    for (let i = 0; i < rawRecords.length; i += BATCH_SIZE) {
        const batch = rawRecords.slice(i, i + BATCH_SIZE);
        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(rawRecords.length / BATCH_SIZE)} (items ${i + 1}-${i + batch.length})...`);
        const annotations = await annotateBatch(batch);

        batch.forEach((item, idx) => {
            const ann = annotations.find(a => a.index === idx || a.id === item.id) || annotations[idx] || {};
            annotatedNewRecords.push({
                source: item.source,
                id: item.id,
                text: item.text,
                author: item.author,
                timestamp: item.timestamp,
                barangay: ann.barangay || "Unknown",
                incident_type: ann.incident_type || "none",
                intent: ann.intent || "EMERGENCY_REPORT",
                urgency: ann.urgency || "HIGH",
                ner_spans: Array.isArray(ann.ner_spans) ? ann.ner_spans : []
            });
        });

        await sleep(500);
    }

    console.log(`\nSuccessfully annotated all ${annotatedNewRecords.length} new records!`);

    // Load existing synthetic dataset if any
    let existingSynthetic = [];
    if (fs.existsSync(SYNTHETIC_JSONL)) {
        existingSynthetic = fs.readFileSync(SYNTHETIC_JSONL, "utf8")
            .trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
        console.log(`Found ${existingSynthetic.length} existing synthetic records.`);
    }

    // Merge synthetic
    const combinedSynthetic = [...existingSynthetic, ...annotatedNewRecords];
    fs.writeFileSync(SYNTHETIC_JSONL, combinedSynthetic.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.writeFileSync(SYNTHETIC_CSV, toCSV(combinedSynthetic), "utf8");
    console.log(`✅ Saved ${combinedSynthetic.length} total synthetic records to ${SYNTHETIC_JSONL} and ${SYNTHETIC_CSV}`);

    // Load cleaned real dataset if exists
    let cleanedRealRows = [];
    if (fs.existsSync(CLEANED_REAL_JSONL)) {
        cleanedRealRows = fs.readFileSync(CLEANED_REAL_JSONL, "utf8")
            .trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
        console.log(`Loaded ${cleanedRealRows.length} cleaned real records.`);
    }

    // Combine for full annotated dataset
    const fullAnnotated = [...cleanedRealRows, ...combinedSynthetic];
    fs.writeFileSync(ANNOTATED_JSONL, fullAnnotated.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
    fs.writeFileSync(ANNOTATED_CSV, toCSV(fullAnnotated), "utf8");
    console.log(`✅ Saved ${fullAnnotated.length} total records to ${ANNOTATED_JSONL} and ${ANNOTATED_CSV}`);

    console.log("\nIncident Type Distribution:");
    const incidentCounts = {};
    fullAnnotated.forEach(r => {
        incidentCounts[r.incident_type] = (incidentCounts[r.incident_type] || 0) + 1;
    });
    console.table(incidentCounts);

    console.log("\nIntent Distribution:");
    const intentCounts = {};
    fullAnnotated.forEach(r => {
        intentCounts[r.intent] = (intentCounts[r.intent] || 0) + 1;
    });
    console.table(intentCounts);
}

main().catch(err => {
    console.error("❌ Fatal error:", err);
    process.exit(1);
});
