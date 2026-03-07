"""
Voice Agent Service

Uses Groq (Llama 3) for demographic extraction and scenario interpretation.
Condition detection is primarily deterministic via keyword matching against
the MEPS-backed condition list. When regex fails, an LLM fallback maps
unrecognized terms to the closest condition key(s) from the 46.
"""

import json
import re
from groq import AsyncGroq
from app.config import GROQ_API_KEY
from app.data.comorbidity_loader import CONDITION_TO_ICD

client = AsyncGroq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

# Build condition key → label mapping for the LLM prompt
_CONDITION_KEY_LIST = sorted(CONDITION_TO_ICD.keys())

SYSTEM_PROMPT = """You are a medical voice assistant. You help patients understand
their health care costs through a clinical-financial digital twin.

Prompts may come in the form of a patient describing their symptoms, conditions, OR diseases they already have.

Your role:
- Parse patient descriptions into structured profiles (age, sex, conditions, insurance)
- Interpret what-if questions about interventions and scenarios
- Explain simulation results in plain, empathetic language

CRITICAL RULES:
- NEVER invent or hallucinate cost numbers. All costs come from the simulation engine.
- When you need to present numbers, use the data provided in the context.
- Be empathetic but direct. Patients need clarity, not hedging.
- Keep responses concise — this is a voice interface."""


# ── Deterministic condition detection ──
# Each condition maps to a list of keyword patterns (regex).
# Matched against lowercased user text. Order matters: first match wins
# for overlapping symptoms (e.g. "diabetes" matches type_2 before pre-diabetes
# only if "pre" is absent).

CONDITION_PATTERNS: dict[str, list[str]] = {
    # ── Diabetes spectrum ──
    "diabetes": [
        r"\btype\s*2\s*diabet",
        r"\bt2d\b",
        r"\btype\s*ii\s*diabet",
        r"\binsulin\s*resistan",
        r"\ba1c\b.*\b(high|elevated|above)",
        r"\bhigh\s*a1c\b",
        r"\bdiabetic\b",
        r"\bdiabetes\b",
        r"\bsugar\b.*\b(high|through the roof|out of control|spiking|elevated|crazy)",
        r"\b(high|elevated)\s*sugar\b",
        r"\bon\s*insulin\b",
    ],
    "pre-diabetes": [
        r"\bpre[\s-]*diabet",
        r"\bprediabet",
        r"\bborderline\s*diabet",
        r"\bblood\s*sugar\b.*\b(high|elevated)",
        r"\bhigh\s*blood\s*sugar",
        r"\bfrequent\s*(urinat|pee|bathroom)",
        r"\b(pee|urinat|bathroom)\b.*\b(frequent|often|lot|constantly|every)",
        r"\balways\s*(pee|urinat|thirsty)",
        r"\bincreased\s*thirst",
        r"\bexcessive\s*thirst",
    ],
    # ── Cardiovascular ──
    "hypertension": [
        r"\bhypertens",
        r"\bhigh\s*blood\s*pressure",
        r"\bhigh\s*bp\b",
        r"\bbp\b.*\b(high|elevated)",
        r"\b(systolic|diastolic)\b.*\b(high|elevated)",
        r"\bblood\s*pressure\b.*\b(high|elevated|through the roof|too high|out of control|spiking)",
        r"\bpressure\s*is\s*(high|up|elevated|too high)",
    ],
    "high_cholesterol": [
        r"\bhigh\s*cholest",
        r"\bhyperlipid",
        r"\bhypercholest",
        r"\bhigh\s*ldl\b",
        r"\belevated\s*(cholest|ldl|triglycer)",
        r"\bhigh\s*triglycer",
        r"\blipid\s*(disorder|metabolism)",
    ],
    "cad": [
        r"\bcoronary\s*artery",
        r"\bcad\b",
        r"\bischemic\s*heart",
        r"\bangina",
        r"\bchest\s*pain\b",
        r"\bblocked\s*arter",
        r"\bclogged\s*arter",
        r"\barter\w*\b.*\b(clogged|blocked|narrow|hardened|stiff|calcif)",
        r"\b(clogged|blocked|narrow|hardened)\b.*\barter",
        r"\bheart\b.*\b(block|clog)",
        r"\bstent\b",
        r"\bbypass\b.*\b(surgery|heart)",
        r"\bangioplasty\b",
    ],
    "heart_failure": [
        r"\bheart\s*failure",
        r"\bcongestive\s*heart",
        r"\bchf\b",
        r"\bcardiac\s*insufficiency",
        r"\bheart\b.*\b(weak|enlarged|pumping|giving out|failing)",
        r"\bfluid\s*retention\b",
        r"\bheart\b.*\b(not\s*pumping|can'?t\s*pump)",
        r"\bweak\s*heart\b",
    ],
    "arrhythmia": [
        r"\barrhythmi",
        r"\batrial\s*fib",
        r"\bafib\b",
        r"\ba[\s-]?fib\b",
        r"\birregular\s*heart",
        r"\bheart\b.*\b(irregular|racing|palpitat)",
        r"\bpalpitat",
        r"\btachycardi",
        r"\bbradycardi",
    ],
    "valve_disorder": [
        r"\bvalve\s*(disorder|disease|problem|regurg|stenos)",
        r"\bheart\s*valve",
        r"\bmitral\b",
        r"\baortic\s*(stenos|regurg|valve)",
    ],
    "atherosclerosis": [
        r"\batheros",
        r"\bperipheral\s*arter",
        r"\bpaod\b",
        r"\bpad\b.*\b(arter|vascular)",
        r"\bperipheral\s*vascular",
    ],
    "hypotension": [
        r"\bhypotens",
        r"\blow\s*blood\s*pressure",
    ],
    "varicosis": [
        r"\bvaricos",
        r"\bvaricose\s*vein",
        r"\bvein\b.*\b(swollen|bulging)",
    ],
    "stroke": [
        r"\bstroke\b",
        r"\bcerebral\s*ischem",
        r"\bcerebrovascular",
        r"\btia\b",
        r"\btransient\s*ischemic",
    ],
    # ── Kidney ──
    "ckd": [
        r"\bckd\b",
        r"\bchronic\s*kidney",
        r"\bkidney\s*(disease|damage|issues|problems|failure|failing|not\s*working|bad|going)",
        r"\brenal\s*(insufficien|failure|disease)",
        r"\bprotein\s*in\s*(urine|pee)",
        r"\breduced\s*kidney",
        r"\bkidney\s*function\b.*\b(low|reduced|declining)",
        r"\bkidneys?\b.*\b(bad|failing|going|shutting|shot|damaged|weak)",
        r"\b(bad|failing|weak|damaged)\s*kidney",
        r"\bon\s*dialysis\b",
    ],
    "kidney_stones": [
        r"\bkidney\s*stone",
        r"\brenal\s*(calcul|stone|lithiasis)",
        r"\burinary\s*(tract\s*)?calcul",
        r"\bnephrolithiasis",
    ],
    # ── Metabolic / Endocrine ──
    "obesity": [
        r"\bobes",
        r"\bbmi\b.*\b(high|over|above|30|35|40)",
        r"\bmorbidly\s*overweight",
        r"\boverweight\b",
        r"\b(really|very|extremely|super|too)\s*(heavy|fat|big)\b",
        r"\bweight\b.*\b(problem|issue|too much|out of control|can'?t\s*lose)",
    ],
    "thyroid_disease": [
        r"\bthyroid",
        r"\bhypothyroid",
        r"\bhyperthyroid",
        r"\bhashimoto",
        r"\bgraves\b.*\bdisease",
        r"\bgoiter\b",
    ],
    "gout": [
        r"\bgout\b",
        r"\bhyperuricemi",
        r"\buric\s*acid\b.*\b(high|elevated)",
    ],
    # ── Respiratory ──
    "asthma_copd": [
        r"\basthma\b",
        r"\bcopd\b",
        r"\bchronic\s*obstruct",
        r"\bemphysema",
        r"\bchronic\s*bronchit",
        r"\bwheezing\b",
        r"\bshortness\s*of\s*breath",
        r"\b(can\s*not|can'?t|cannot|hard\s*to|trouble|difficulty|struggle\s*to)\s*breathe?\b",
        r"\bbreathing\b.*\b(problem|issue|trouble|hard|difficult)\w*",
        r"\bout\s*of\s*breath\b",
        r"\binhaler\b",
        r"\blungs?\b.*\b(bad|weak|damaged|scarred|not\s*working)",
        r"\bbad\s*lungs?\b",
    ],
    # ── GI ──
    "gerd": [
        r"\bgerd\b",
        r"\bacid\s*reflux",
        r"\bgastritis",
        r"\bheartburn\b",
        r"\bgastroesophageal",
        r"\breflux\b",
    ],
    "liver_disease": [
        r"\bliver\s*(disease|cirrho|damage|failure|fibrosis|problem|issue|bad|failing|inflam|scarr)",
        r"\bhepatitis\b",
        r"\bfatty\s*liver",
        r"\bnafld\b",
        r"\bnash\b",
        r"\bcirrhosis",
        r"\bliver\b.*\b(bad|damaged|failing|scarred|inflamed|enlarged|not\s*working|shot)",
        r"\b(bad|damaged|scarred)\s*liver\b",
    ],
    "gallstones": [
        r"\bgallstone",
        r"\bcholecystitis",
        r"\bgallbladder\b.*\b(stone|inflam|problem)",
    ],
    "diverticulosis": [
        r"\bdiverticul",
    ],
    "hemorrhoids": [
        r"\bhemorrhoid",
        r"\bpiles\b",
    ],
    # ── Musculoskeletal ──
    "back_pain": [
        r"\b(low|lower|chronic)\s*back\s*pain",
        r"\bback\s*pain\b",
        r"\blumbar\b",
        r"\bsciatica\b",
        r"\bspinal\s*stenos",
        r"\bdisc\s*(herniat|bulg|degenerat)",
        r"\bback\b.*\b(hurts|killing|aching|sore|bad|messed up|out|thrown out|stiff)",
        r"\b(bad|messed up|thrown out|busted)\s*back\b",
        r"\bslipped\s*dis[ck]\b",
    ],
    "arthritis": [
        r"\brheumatoid\s*arthrit",
        r"\bra\b.*\barthrit",
        r"\bpolyarthrit",
        r"\brheumatoid\b",
        r"\bjoint\w*\b.*\b(inflam|swoll|swell|stiff|pain|hurt|ache|sore|bad)",
        r"\b(swell|swoll|inflam)\w*\b.*\bjoint",
        r"\barthrit",
        r"\b(stiff|swollen|swelling|painful)\s*joint",
    ],
    "arthrosis": [
        r"\barthrosis",
        r"\bosteoarthrit",
        r"\bjoint\s*(degenerat|wear|grind|worn)",
        r"\bknee\w*\b.*\b(pain|replac|arthr|bad|shot|gone|hurts|killing|sore|swollen|stiff)",
        r"\bhip\w*\b.*\b(pain|replac|arthr|bad|shot|gone|hurts|killing|sore|stiff)",
        r"\b(bad|shot|busted|messed up)\s*(knee|hip|knees|hips)\b",
    ],
    "osteoporosis": [
        r"\bosteoporo",
        r"\bbone\s*(loss|density|thin)",
        r"\bfracture\b.*\b(osteo|fragil|compress)",
    ],
    # ── Neurological ──
    "neuropathy": [
        r"\bneuropath",
        r"\btingling\b.*\b(hands|feet|fingers|toes)",
        r"\bnumbness\b.*\b(hands|feet|fingers|toes)",
        r"\bnerve\s*(damage|pain)\b",
    ],
    "dementia": [
        r"\bdementia\b",
        r"\balzheimer",
        r"\bcognitive\s*(decline|impair)",
        r"\bmemory\s*(loss|problem|impair)",
    ],
    "parkinsons": [
        r"\bparkinson",
        r"\btremor\b",
        r"\bshaking\b.*\b(hands|rest)",
    ],
    "migraine": [
        r"\bmigraine",
        r"\bchronic\s*headache",
        r"\bcluster\s*headache",
        r"\bsevere\s*headache",
    ],
    "dizziness": [
        r"\bdizziness\b",
        r"\bvertigo\b",
        r"\bbalance\s*(problem|disorder|issue)",
    ],
    # ── Mental health ──
    "depression": [
        r"\bdepression\b",
        r"\bdepressed\b",
        r"\bmajor\s*depressive",
        r"\bmdd\b",
        r"\b(feeling|been|always|constantly)\s*(sad|hopeless|down|empty|worthless|numb)\b",
        r"\b(lost|no)\s*(interest|motivation|energy|will)\b",
        r"\bmental\s*health\b",
        r"\bantidepressant",
    ],
    "anxiety": [
        r"\banxiety\b",
        r"\banxious\b",
        r"\bgeneralized\s*anxiety",
        r"\bgad\b",
        r"\bpanic\s*(attack|disorder)",
        r"\bsocial\s*anxiety",
        r"\b(constant|always|chronic)\s*(worry|worrying|worried|nervous|stressed|on\s*edge)\b",
        r"\bworr(y|ied|ying)\b.*\b(all\s*the\s*time|constantly|always|too\s*much|everything)\b",
        r"\b(always|constantly)\b.*\bworr(y|ied|ying)\b",
    ],
    "somatoform": [
        r"\bsomatoform",
        r"\bsomatic\s*symptom",
        r"\bpsychosomatic",
    ],
    "insomnia": [
        r"\binsomnia\b",
        r"\bsleep\s*(disorder|problem|trouble|issue|apnea)",
        r"\bcan'?t\s*sleep\b",
        r"\bdifficulty\s*sleep",
        r"\bnever\s*sleep\b",
        r"\b(don'?t|doesn'?t|barely|hardly)\s*sleep\b",
        r"\bup\s*all\s*night\b",
    ],
    # ── Eyes / Ears ──
    "vision_loss": [
        r"\bvision\s*(loss|reduc|impair|problem|getting\s*worse|going|blurr|failing)",
        r"\bretinopathy",
        r"\bdiabetic\s*eye",
        r"\beye\s*damage\b.*\bdiabet",
        r"\bmacular\b.*\b(edema|degenerat)",
        r"\bglaucoma\b",
        r"\bcataract",
        r"\bblind",
        r"\b(can'?t|cannot|hard\s*to|trouble|losing)\s*(see|seeing|read)\b",
        r"\beye\w*\b.*\b(bad|going|failing|getting\s*worse|blurr|problem|issue)",
        r"\blosing\s*(my\s*)?(sight|vision|eyesight)\b",
    ],
    "hearing_loss": [
        r"\bhearing\s*(loss|impair|problem|aid|getting\s*worse|going)",
        r"\bdeaf",
        r"\btinnitus\b",
        r"\b(can'?t|cannot|hard\s*to)\s*hear\b",
        r"\bears?\b.*\b(ringing|bad|going|problem)",
        r"\blosing\s*(my\s*)?hearing\b",
    ],
    # ── Hematologic ──
    "anemia": [
        r"\banemia\b",
        r"\banemic\b",
        r"\b(low|reduced)\s*(iron|hemoglobin|hgb|hb)\b",
        r"\biron\s*deficien",
    ],
    "cancer": [
        r"\bcancer\b",
        r"\btumor\b",
        r"\bmalignant\b",
        r"\boncolog",
        r"\bleukemia\b",
        r"\blymphoma\b",
        r"\bcarcinoma\b",
        r"\bchemotherap",
        r"\bradiation\s*therap",
    ],
    # ── Skin / Immune ──
    "psoriasis": [
        r"\bpsoriasis",
        r"\bpsoriatic",
    ],
    "allergy": [
        r"\ballerg",
        r"\bhay\s*fever",
        r"\brhinitis",
        r"\banaphylax",
        r"\beczema\b",
        r"\batopic\s*dermatit",
    ],
    # ── Urological / Gynecological ──
    "urinary_incontinence": [
        r"\burinary\s*incontinence",
        r"\bbladder\s*(control|leak|problem)",
        r"\boveractive\s*bladder",
        r"\bincontinence\b",
    ],
    "prostatic_hyperplasia": [
        r"\bprostatic\s*hyperplasia",
        r"\bbph\b",
        r"\benlarged\s*prostate",
        r"\bprostate\b.*\b(enlarged|problem|issue)",
    ],
    "gynecological": [
        r"\bmenopaus",
        r"\bendometrios",
        r"\buterine\s*(fibroid|prolaps)",
        r"\bgynecolog",
    ],
    # ── Other ──
    "tobacco_use": [
        r"\bsmok(e|er|ing)\b",
        r"\btobacco\b",
        r"\bnicotine\b",
    ],
    "sexual_dysfunction": [
        r"\bsexual\s*dysfunct",
        r"\berectile\s*dysfunct",
        r"\bed\b.*\b(problem|issue|dysfunct)",
    ],
}


def detect_conditions(text: str) -> list[str]:
    """
    Deterministic condition detection from user text.
    Uses regex keyword matching — same input always gives same output.
    """
    lower = text.lower()
    matched = []
    for condition, patterns in CONDITION_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, lower):
                matched.append(condition)
                break
    return matched


def _is_health_related(text: str) -> bool:
    """
    Quick check if the text mentions anything health-related.

    This gate should be PERMISSIVE — it's better to let an ambiguous input
    through (the LLM will handle it) than to reject a valid health description.
    People describe health in wildly different ways: "my arteries are clogged",
    "sugar's through the roof", "can't breathe", "knees are shot", etc.
    """
    # Phrasing patterns: common ways people describe health issues
    health_phrasing = [
        r"\bi\s+(have|had|got|suffer|experience|was diagnosed|am diagnosed|'ve been diagnosed|live with|deal with|struggle with|developed|caught)\b",
        r"\bdiagnosed\s+with\b",
        r"\bsuffering\s+from\b",
        r"\bmy\s+(doctor|physician|specialist|cardiologist|surgeon|nurse|therapist|psychiatrist)\b",
        r"\btaking\s+(medication|medicine|pills|drugs|meds)\b",
        r"\b(disease|disorder|syndrome|chronic|condition|diagnosis|infection)\b",
        # "my [body part]" — people describe issues by referencing their body
        r"\bmy\s+(heart|lung|kidney|liver|stomach|back|knee|hip|joint|bone|arteri|vein|blood|sugar|thyroid|prostate|bladder|brain|eye|ear|skin|chest|head|leg|arm|foot|feet|hand|neck|spine|pancrea|colon|intestin|gallbladder|throat)",
        # "I feel" / "I'm" + symptom
        r"\bi\s+(feel|am|'m)\s+(sick|ill|dizzy|nauseous|weak|tired|exhausted|depressed|anxious|bloated|short of breath|light\s*headed)",
        r"\b(can\s*not|can'?t|cannot|couldn'?t|have\s+trouble|unable\s+to)\s+(breathe|sleep|walk|see|hear|move|swallow|eat|focus|remember)",
        # "something hurts/aches/is wrong"
        r"\b(hurts|aching|aches|swollen|swelling|sore|painful|stiff|numb|bleeding|burning|itching|cramping)\b",
        # "I've been [symptom]ing" — progressive tense symptom descriptions
        r"\bi'?ve\s+been\s+\w*(throw|cough|wheez|bleed|vomit|sneez|itch|ach|hurt|swell|cramp|faint|puk)\w*",
        r"\bi\s+keep\s+\w*(throw|cough|wheez|bleed|vomit|sneez|itch|faint|puk)\w*",
    ]

    # Body parts — if ANY body part is mentioned, this is likely health-related
    body_parts = [
        r"\b(heart|lungs?|kidneys?|liver|stomach|intestin|colon|pancrea|spleen|gallbladder)\b",
        r"\b(arteri|arter\w+|vein|blood\s*vessel|capillar|aorta|vascular)\b",
        r"\b(brain|spine|spinal|nerv|neural)\b",
        r"\b(bone|joint|cartilage|tendon|ligament|muscle|skeletal)\b",
        r"\b(knee|hip|shoulder|ankle|wrist|elbow|finger|toe)\b",
        r"\b(eye|retina|cornea|ear|eardrum|sinus)\b",
        r"\b(skin|scalp|nail|rash)\b",
        r"\b(throat|esophag|trachea|larynx|vocal)\b",
        r"\b(bladder|urethr|ureter|uterus|ovary|prostate|rectum)\b",
        r"\b(thyroid|adrenal|pituitary|gland)\b",
        r"\b(chest|abdomen|pelvis|groin)\b",
    ]

    # Symptom descriptors — colloquial ways of describing health problems
    symptom_words = [
        r"\b(clogged|blocked|narrow|hardened|inflamed|infected|damaged|failing|swollen|enlarged|bleeding|leaking)\b",
        r"\b(pain|ache|sore|tender|stiff|numb|tingle|tingling|throb|cramp|spasm|burning|itchy|itching)\b",
        r"\b(dizzy|faint|nausea|vomit|wheez|cough|sneez|fever|chills|sweat)\b",
        r"\b(throw\w*\s*up|puk\w*|gag\w*|retch\w*|dry\s*heav\w*|sick\s*to\s*my\s*stomach)\b",
        r"\b(fatigue|tired|exhausted|weak|letharg|drowsy|groggy)\b",
        r"\b(worried|worrying|anxious|stressed|nervous|restless|panick|overwhelmed|scared)\b",
        r"\b(depressed|hopeless|sad|empty|miserable|suicidal|worthless)\b",
        r"\b(pee|urinat|peeing|urinating|constipat|diarrhea|bloat)\b",
        r"\b(short\s*of\s*breath|breathless|can'?t\s*breathe|difficulty\s*breath|breathing\s*(problem|issue|trouble|difficult)\w*)\b",
        r"\b(blurry|blind|deaf|ringing|hearing\s*loss)\b",
        r"\b(overweight|obese|underweight|gained\s*weight|lost\s*weight)\b",
        r"\b(diagnosed|surgery|operation|hospital|emergency|er\b|icu\b|urgent\s*care)\b",
        r"\b(lump|bump|growth|mole|lesion|wound|scar|bruise)\b",
        r"\b(snor\w*|apnea|sleep\w*)\b",
        r"\b(seizure|convuls|faint|pass\w*\s*out|black\w*\s*out)\b",
    ]

    # Medical/clinical keywords
    health_keywords = [
        r"\b(diabet|blood\s*sugar|a1c|insulin|glucose|sugar\s*level|sugar\s*is)\b",
        r"\b(blood\s*pressure|hypertens|bp)\b",
        r"\b(cholesterol|cholest|ldl|hdl|triglycerides?|triglycer|lipids?)\b",
        r"\b(kidney|ckd|renal)\b",
        r"\b(heart|cardiac|coronary|angina|arrhythmi|afib|valve)\b",
        r"\b(neuropath|tingling|numbness|nerve)\b",
        r"\b(retinopathy|eye\s*damage|vision|glaucoma|cataract)\b",
        r"\b(pee|urinat|bathroom)\b.*\b(frequent|often|lot|every|always)\b",
        r"\b(frequent|often|always)\b.*\b(pee|urinat|bathroom)\b",
        r"\b(thirst|fatigue|tired|exhausted)\b",
        r"\b(insurance|ppo|hmo|hdhp|deductible|copay|premium|medicare|medicaid|uninsured)\b",
        r"\b(condition|diagnosis|symptom|doctor|medication|prescription|treatment|therapy|meds)\b",
        r"\b(health|medical|clinical|hospital|clinic|pharmacy|ambulance)\b",
        r"\b\d{1,3}\s*(year|yr)s?\s*old\b",
        r"\b(male|female|man|woman)\b",
        r"\b(obes|bmi|overweight)\b",
        r"\b(depress|anxiety|anxious|panic|insomnia|sleep)\b",
        r"\b(asthma|copd|emphysema|bronchit|wheezing)\b",
        r"\b(arthrit|arthrosis|osteoarthrit)\b",
        r"\b(gerd|reflux|heartburn|gastritis)\b",
        r"\b(liver|hepat|cirrho|fatty\s*liver)\b",
        r"\b(thyroid|hypothyroid|hyperthyroid)\b",
        r"\b(gout|uric\s*acid)\b",
        r"\b(osteoporo|bone\s*loss)\b",
        r"\b(back\s*pain|lumbar|sciatica)\b",
        r"\b(anemia|iron\s*deficien)\b",
        r"\b(migraine|headache)s?\b",
        r"\b(cancer|tumor|malignant|oncol|leukemia|lymphoma)\b",
        r"\b(dementia|alzheimer|memory\s*loss)\b",
        r"\b(parkinson|tremor)\b",
        r"\b(allerg|hay\s*fever|eczema)\b",
        r"\b(psoriasis|psoriatic)\b",
        r"\b(stroke|tia|cerebrovascular)\b",
        r"\b(prostate|bph)\b",
        r"\b(incontinence|bladder)\b",
        r"\b(smok|tobacco|nicotine)\b",
    ]
    lower = text.lower()
    return (any(re.search(p, lower) for p in health_phrasing)
            or any(re.search(p, lower) for p in body_parts)
            or any(re.search(p, lower) for p in symptom_words)
            or any(re.search(p, lower) for p in health_keywords))


async def _llm_is_health_related(text: str) -> bool:
    """LLM fallback for health-relatedness when regex doesn't match."""
    if client is None:
        return False
    try:
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": """Determine if the user's message describes a health symptom, medical condition, disease, physical complaint, or anything related to their body/health.
Return JSON: {"health_related": true} or {"health_related": false}
Be GENEROUS — if there's any chance the user is describing a health issue, return true.
Examples that ARE health-related: "I've been throwing up", "my feet are weird", "I can't stop scratching", "something is wrong with my stomach", "I feel off", "I have a rash"
Examples that are NOT health-related: "hello", "what's the weather", "tell me a joke", random names, gibberish"""},
                {"role": "user", "content": text},
            ],
            temperature=0,
            response_format={"type": "json_object"},
        )
        result = json.loads(response.choices[0].message.content)
        return result.get("health_related", False)
    except Exception:
        return False


async def resolve_conditions(text: str, already_detected: list[str]) -> dict:
    """
    LLM fallback: map unrecognized symptoms/diseases to the closest
    condition key(s) from the 46 CONDITION_TO_ICD keys.

    Distinguishes between:
    - "disease_matches": user named a disease that maps to one of the 46
      → treated as confirmed current conditions
    - "symptom_matches": user described symptoms that COULD indicate a condition
      → treated as possible/suspected conditions (not 100%)
    - "unmapped": truly doesn't fit any of the 46

    Returns {"disease_matches": [...], "symptom_matches": [...], "unmapped": [...]}
    """
    if client is None:
        return {"disease_matches": [], "symptom_matches": [], "symptom_scores": {}, "unmapped": []}

    keys_str = ", ".join(_CONDITION_KEY_LIST)

    try:
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": f"""You are a medical condition mapper. The user will describe symptoms or diseases.
Your job: map each mentioned condition/symptom to the CLOSEST matching key(s) from this list of 46 condition keys:

{keys_str}

Already detected conditions (do NOT repeat these): {', '.join(already_detected) if already_detected else 'none'}

CRITICAL: distinguish between symptoms and diseases.
- If the user names an ACTUAL DISEASE or DIAGNOSIS (e.g. "lupus", "celiac disease", "fibromyalgia"), put the mapped key in "disease_matches"
- If the user describes SYMPTOMS (e.g. "cough", "throwing up", "chest pain", "fatigue", "can't sleep"), think about the top differential diagnoses for those symptoms and return them in "symptom_matches" with a relevance score — symptoms are NOT confirmed diagnoses
- ALWAYS return at least 1 symptom_match for any health-related input. Every symptom has a differential diagnosis that maps to one of the 46 keys.
  Examples: "throwing up" → gerd (0.8), liver_disease (0.4); "headache" → migraine (0.9), hypertension (0.3); "feeling tired" → anemia (0.6), thyroid_disease (0.5), depression (0.4)
- IMPORTANT: use ONLY exact keys from the list above. Do NOT invent keys or combine them (e.g. use "gerd" not "gerd_gastritis", use "cad" not "coronary_artery_disease").
- For vague symptoms, return up to 3 of the MOST LIKELY causes from the 46 keys (ranked by clinical likelihood). Do not return more than 3 symptom matches.
- Only put something in "unmapped" if it is truly NOT a health symptom or condition (e.g. a name, a place). If the user describes ANY bodily symptom, you MUST map it to at least one condition key.
- Be generous with mapping — most conditions relate to at least one of the 46
- Return ONLY valid JSON, no other text

Each symptom_match must include a "relevance" score (0.0 to 1.0):
  0.8-1.0 = strong/direct match (e.g. "clogged arteries" → cad)
  0.4-0.7 = moderate match (e.g. "clogged arteries" → heart_failure)
  0.1-0.3 = weak/indirect match (e.g. "clogged arteries" → stroke)

Return JSON: {{"disease_matches": ["key1"], "symptom_matches": [{{"condition": "key2", "relevance": 0.85}}, {{"condition": "key3", "relevance": 0.4}}], "unmapped": ["term1"]}}"""},
                {"role": "user", "content": text},
            ],
            temperature=0,
            response_format={"type": "json_object"},
        )
        raw_content = response.choices[0].message.content
        print(f"[resolve_conditions] raw LLM response: {raw_content}")
        result = json.loads(raw_content)
        disease = [c for c in result.get("disease_matches", [])
                   if c in CONDITION_TO_ICD and c not in already_detected]

        # Parse symptom_matches: handle both new dict format and legacy string format
        raw_symptoms = result.get("symptom_matches", [])
        symptom = []
        symptom_scores = {}
        for item in raw_symptoms:
            if isinstance(item, dict):
                cond = item.get("condition", "")
                relevance = float(item.get("relevance", 0.4))
            else:
                cond = str(item)
                relevance = 0.4  # fallback for old string format
            if cond in CONDITION_TO_ICD and cond not in already_detected:
                symptom.append(cond)
                symptom_scores[cond] = max(0.0, min(1.0, relevance))
        symptom = symptom[:3]
        symptom_scores = {k: symptom_scores[k] for k in symptom}

        unmapped = result.get("unmapped", [])
        # Filter out insurance terms from unmapped
        insurance_terms = {"ppo", "hmo", "hdhp", "medicare", "medicaid", "cobra", "tricare"}
        unmapped = [u for u in unmapped if u.lower().strip() not in insurance_terms]

        # Filter unmapped terms that overlap with already-detected conditions.
        # e.g. "asthma" should be dropped if "asthma_copd" is already detected.
        all_detected = set(already_detected) | set(disease) | set(symptom)
        def _overlaps_detected(term: str) -> bool:
            t = term.lower().strip().replace(" ", "_")
            for det in all_detected:
                # "asthma" in "asthma_copd" or "asthma_copd" in "asthma"
                if t in det or det in t:
                    return True
            return False
        unmapped = [u for u in unmapped if not _overlaps_detected(u)]

        # If LLM returned nothing at all, treat the input as unmapped
        if not disease and not symptom and not unmapped:
            unmapped = [text]
        return {"disease_matches": disease, "symptom_matches": symptom, "symptom_scores": symptom_scores, "unmapped": unmapped}
    except Exception as e:
        print(f"[resolve_conditions] EXCEPTION: {e}")
        return {"disease_matches": [], "symptom_matches": [], "symptom_scores": {}, "unmapped": []}


async def parse_patient_input(text: str) -> dict:
    """
    Parse natural language patient description into a structured profile.
    Conditions are detected deterministically via keyword matching.
    The LLM only extracts age, sex, and insurance type.
    """
    if not _is_health_related(text):
        # Regex didn't match — ask the LLM before rejecting
        if not await _llm_is_health_related(text):
            return {"off_topic": True}

    # Detect conditions deterministically
    conditions = detect_conditions(text)

    # Use LLM only for demographics (age, sex, insurance)
    age = None
    sex = None
    insurance_type = "unknown"
    lower = text.lower()

    # Try to extract age from text directly
    age_match = re.search(r"\b(\d{1,3})\s*(?:year|yr|y/?o|years?\s*old)\b", lower)
    if age_match:
        age = int(age_match.group(1))

    # Keyword-to-approximate-age mapping (only if no numeric age found)
    if age is None:
        age_words = {
            "elderly": 75, "senior": 72, "old": 70,
            "middle-aged": 50, "middle aged": 50,
            "young adult": 25, "teenager": 16, "teen": 16,
            "child": 8, "infant": 1, "baby": 1,
            "young": 28,
        }
        for word, approx_age in age_words.items():
            if re.search(r"\b" + re.escape(word) + r"\b", lower):
                age = approx_age
                break

    # Try to extract sex from text directly
    if re.search(r"\b(male|man|boy|he|his)\b", lower) and not re.search(r"\bfe?male\b", lower):
        sex = "M"
    elif re.search(r"\b(female|woman|girl|she|her)\b", lower):
        sex = "F"

    # Try to extract insurance from text directly
    if re.search(r"\bppo\b", lower):
        insurance_type = "PPO"
    elif re.search(r"\bhmo\b", lower):
        insurance_type = "HMO"
    elif re.search(r"\bhdhp\b", lower):
        insurance_type = "HDHP"
    elif re.search(r"\bmedicare\b", lower):
        insurance_type = "MEDICARE"
    elif re.search(r"\bmedicaid\b", lower):
        insurance_type = "MEDICAID"
    elif re.search(r"\buninsured\b", lower):
        insurance_type = "NONE"
    elif re.search(r"\b(poverty|poor|low[\s-]*income|can'?t\s*afford|no\s*(health\s*)?insurance|broke)\b", lower):
        insurance_type = "MEDICAID"

    # Fall back to LLM only if we couldn't extract age
    if age is None and client is not None:
        try:
            response = await client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": """Extract ONLY the age, sex, and insurance type from the user's message.
Return JSON: {"age": int or null, "sex": "M" or "F" or null, "insurance_type": "PPO"|"HMO"|"HDHP"|"unknown"}
Do NOT extract or infer any medical conditions. Return ONLY valid JSON."""},
                    {"role": "user", "content": text},
                ],
                temperature=0,
                response_format={"type": "json_object"},
            )
            demographics = json.loads(response.choices[0].message.content)
            if age is None and demographics.get("age"):
                age = demographics["age"]
            if sex is None and demographics.get("sex"):
                sex = demographics["sex"]
            if insurance_type == "unknown" and demographics.get("insurance_type", "unknown") != "unknown":
                insurance_type = demographics["insurance_type"]
        except Exception:
            pass

    # LLM fallback: always try to resolve additional conditions the regex missed.
    # People describe health in many ways that regex can't fully capture.
    symptom_conditions = []
    symptom_scores = {}
    unmapped_conditions = []
    if client is not None:
        resolved = await resolve_conditions(text, conditions)
        conditions.extend(resolved["disease_matches"])
        symptom_conditions = resolved["symptom_matches"]
        symptom_scores = resolved.get("symptom_scores", {})
        unmapped_conditions = resolved["unmapped"]
        print(f"[parse_patient_input] text={text!r} conditions={conditions} symptom_conditions={symptom_conditions} scores={symptom_scores} unmapped={unmapped_conditions}")

    return {
        "off_topic": False,
        "age": age,
        "sex": sex,
        "conditions": conditions,
        "symptom_conditions": symptom_conditions,
        "symptom_scores": symptom_scores,
        "unmapped_conditions": unmapped_conditions,
        "insurance_type": insurance_type,
    }


async def interpret_scenario(text: str, current_conditions: list[str]) -> dict:
    """Parse a what-if question into intervention parameters."""
    if client is None:
        return {"error": "GROQ_API_KEY not configured"}

    response = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT + f"""

The patient currently has: {', '.join(current_conditions)}

First, determine if the user's message is related to health, medical conditions, diseases they already have, insurance, or care costs.
If the message is NOT related to health/medical topics, return:
{{"off_topic": true}}

If it IS health-related, parse the user's what-if question. Return JSON with:
{{
  "off_topic": false,
  "intent": "add_intervention" | "remove_intervention" | "compare_plans" | "explain_risk" | "general_question",
  "interventions": ["intervention_1"],
  "plan_comparison": {{"plan_a": "...", "plan_b": "..."}} // only if intent is compare_plans
}}

Available interventions: metformin, sglt2_inhibitor, statin, ace_inhibitor, lifestyle_change

Return ONLY valid JSON, no other text."""},
            {"role": "user", "content": text},
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )

    return json.loads(response.choices[0].message.content)


async def chat_about_health(
    question: str,
    profile: dict,
    graph_summary: dict,
    conversation: list[dict],
) -> str:
    """
    Conversational catch-all: answer any health/cost question using
    the patient's profile and graph data as context.
    """
    if client is None:
        return "Voice agent not configured. Set GROQ_API_KEY."

    # Build context block the LLM can reference
    context_parts = []
    if profile:
        context_parts.append(f"Patient profile: age {profile.get('age', 'unknown')}, "
                             f"sex {profile.get('sex', 'unknown')}, "
                             f"conditions: {', '.join(profile.get('conditions', []))}, "
                             f"insurance: {profile.get('insurance_type', 'unknown')}")
    if graph_summary:
        if graph_summary.get("total_5yr_cost"):
            context_parts.append(f"Projected 5-year total cost: ${graph_summary['total_5yr_cost']:,.0f}")
        if graph_summary.get("total_5yr_oop"):
            context_parts.append(f"Projected 5-year out-of-pocket: ${graph_summary['total_5yr_oop']:,.0f}")
        if graph_summary.get("conditions"):
            context_parts.append(f"Current conditions on graph: {', '.join(graph_summary['conditions'])}")
        if graph_summary.get("top_risks"):
            risks_str = "; ".join(
                f"{r['label']} ({r['probability']:.0%} likelihood, ~${r['annual_cost']:,.0f}/yr)"
                for r in graph_summary["top_risks"]
            )
            context_parts.append(f"Top projected risks: {risks_str}")
        if graph_summary.get("interventions"):
            context_parts.append(f"Active interventions: {', '.join(graph_summary['interventions'])}")

    context_block = "\n".join(context_parts) if context_parts else "No patient data available."

    system_msg = SYSTEM_PROMPT + f"""

You have the following data about this patient's projected care pathway:
{context_block}

RULES:
- Use ONLY the numbers above — NEVER invent costs or probabilities.
- If the patient asks about a risk, reference the top risks and their likelihood.
- If the patient asks what to do, suggest interventions they can add. The available
  interventions in the system are: Metformin, SGLT2 inhibitors, statins, ACE inhibitors,
  and lifestyle changes (diet, exercise, weight management, smoking cessation, etc.).
  ALWAYS describe interventions in plain, patient-friendly language — NEVER output
  raw system keys like "lifestyle_change" or "sglt2_inhibitor". Say "lifestyle changes"
  or "an SGLT2 inhibitor" instead.
- Keep responses concise (2-4 sentences) — this is a voice interface.
- Be warm, direct, and actionable.
- NEVER expose internal system keys or code-style names to the patient."""

    llm_messages = [{"role": "system", "content": system_msg}]

    # Add recent conversation history (last 10 exchanges) for follow-up context
    for msg in conversation[-10:]:
        role = "assistant" if msg.get("role") == "system" else "user"
        llm_messages.append({"role": role, "content": msg.get("text", "")})

    # Add current question if not already the last message
    if not conversation or conversation[-1].get("text") != question:
        llm_messages.append({"role": "user", "content": question})

    response = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=llm_messages,
        temperature=0.3,
    )

    return response.choices[0].message.content


async def generate_explanation(graph_data: dict, question: str) -> str:
    """Generate a natural language explanation of simulation results."""
    if client is None:
        return "Voice agent not configured. Set GROQ_API_KEY."

    response = await client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT + """

Explain the simulation results to the patient. Use the provided data
for all numbers. Keep it under 3 sentences for voice output.
Be warm but clear."""},
            {"role": "user", "content": f"Question: {question}\n\nSimulation data: {graph_data}"},
        ],
        temperature=0.3,
    )

    return response.choices[0].message.content
