# Writing GridX in हिंदी, मराठी, বাংলা, ಕನ್ನಡ and తెలుగు

For whoever writes or edits the catalogues in `i18n/<lang>/`. The English pages are the source and are never edited for a translation's sake. `node tools/i18n.mjs extract` lists every line; `npm run check:i18n` says what is missing or breaks a rule.

## 1. The voice

Write the way a friend who works at a GridX dealership would explain it, sitting across the table: warm, sure of the product, never stiff. This is transcreation, not translation. Read the English, understand what it means and how it feels (`gist.json` says it for every tagline and caption), then say that the way people of that language actually say it.

- **Spoken register, never textbook.** Use the words people use.
  - **Hindi:** everyday Hindustani. बैटरी, चार्ज, चार्जर, ऐप, स्कूटर, ऑर्डर, डीलर, पेमेंट, वारंटी, सर्विस stay the loanwords they are. Never विद्युत संचायक or प्रभार.
  - **Marathi:** the Marathi of Pune and Mumbai. बॅटरी, चार्ज, ॲप, ऑर्डर, डीलर.
  - **Bengali:** Kolkata চলিত ভাষা, never সাধু. ব্যাটারি, চার্জ, অ্যাপ, অর্ডার, ডিলার.
  - **Kannada:** Bengaluru conversational. ಬ್ಯಾಟರಿ, ಚಾರ್ಜ್, ಆ್ಯಪ್, ಆರ್ಡರ್, ಡೀಲರ್.
  - **Telugu:** neutral spoken Telugu, as in Hyderabad and Vijayawada. బ్యాటరీ, ఛార్జ్, యాప్, ఆర్డర్, డీలర్.
- **Local taste where it helps.** An idiom that carries the gist better than a literal phrase is the right choice: ষোলো আনা for "every inch", सगळी कामं फत्ते for "does it all". Do not force one into every line. A premium brand speaks calmly.
- **Respectful "you":** आप, तुम्ही, আপনি, ನೀವು, మీరు. Requests are polite (करें / करा / করুন / ಮಾಡಿ / చేయండి), never commands.
- **Gender-neutral about the reader.** Hindi and Marathi verbs inflect: never "आप पहुँच गए", "तुम्ही आलात" is fine. Prefer present tense, requests and noun phrases. The PowerPod is masculine (पॉड, as the GridX app says "पॉड डॉक हुआ"). A battery (बैटरी / बॅटरी) is feminine.
- **Thriving, exact.** GridX is a thriving company. Never say "small team". The team is lean:
  - हिंदी चुस्त टीम
  - मराठी चपळ टीम
  - বাংলা চটপটে দল
  - ಕನ್ನಡ ಚುರುಕಾದ ತಂಡ
  - తెలుగు చురుకైన బృందం

  The Okhla place is "the office" (ऑफ़िस / ऑफिस / অফিস / ಆಫೀಸ್ / ఆఫీస్), never a lab or R&D floor. Add no fact the English does not state; drop none it does.

## 2. Words that never change

- **Latin script, as written:**
  - GridX, GridXenergy, PowerPod, Gen1, Gen2, PowerPod Platform™, GridX-Pro Pack
  - Komaki, X1, X3
  - WhatsApp, Instagram, YouTube, LinkedIn, Bluetooth, GPS, SOS
  - kWh, km, ₹ and every number
  - **people's names**, exactly as the English writes them (Vishrut Vatsa, Shivanshu Mahim, Hriteek Agrawal…), with the language's grammar around them ("Vishrut Vatsa ने"); a transliteration can misspell a name, and a name is a fact
  - companies, schemes and institutes (SUN Mobility, NIDHI PRAYAS, IIT Roorkee, Battery 360)
- **Western digits always** (29,999, never २९,९९९). Prices exactly as the English prints them: ₹399, ₹29,999, ₹2,199. The build checks every number.
- **Pre-book, never reserve.** Customers pre-book.

  | Language | Verb | Noun |
  |---|---|---|
  | हिंदी | प्री-बुक करें | प्री-बुकिंग |
  | मराठी | प्री-बुक करा | प्री-बुकिंग |
  | বাংলা | প্রি-বুক করুন | প্রি-বুকিং |
  | ಕನ್ನಡ | ಪ್ರೀ-ಬುಕ್ ಮಾಡಿ | ಪ್ರೀ-ಬುಕಿಂಗ್ |
  | తెలుగు | ప్రీ-బుక్ చేయండి | ప్రీ-బుకింగ్ |

  The build rejects any word for a reservation (आरक्षण, रिज़र्व, সংরক্ষণ, ಕಾಯ್ದಿರಿಸು, రిజర్వ్…).
- **"Shipping across India"** is shipping, across India: पूरे भारत में शिपिंग, never only "across India".
- **No em dash (—)** in any language. Use a comma, a colon or a full stop.

## 3. Punctuation

- Hindi and Bengali end a sentence with "।". Marathi, Kannada and Telugu end with ".".
- Commas, question marks, colons and quotes as in English.
- An ellipsis stays "…".
- A heading that has no full stop in English has none in translation.

## 4. The catalogue's format

- **Files:**
  - `common.json`: lines shared by pages (the top bar, the footer, the picker's `lang::` lines, the build's alt texts).
  - `pages/<page>.json`: each page's own lines.
  - `scripts.json`: what scripts write.
- **Keys are the exact English strings** from `source.json`. Never change a key.
- **Placeholders** `<0>`, `</0>`, `<1/>` stand for markup: a link, a bold word, an icon.
  - Keep every one of them; you may move them to where your language puts those words.
  - You may drop only presentational ones around nothing essential. For example, the `<0>th</0>` of an English ordinal: Indian languages do not write "6th", so "6 नवंबर से" drops it.
  - Never invent new ones.
- **" | "** in a key splits a line into parts that are laid out separately:
  - phrases a caption may break between
  - the lines of a headline
  - the three parts of the footer's credit

  Use " | " for the same job, with as many parts as your language needs, except where the English parts have different roles: the footer credit always has exactly three, and its last part is the name.
- **`{name}` values** are filled in by the page: keep each one, anywhere in the sentence.
- **Counts** are written as two forms. The English key `"{n} hour|{n} hours"` takes `{ "one": "{n} घंटा", "other": "{n} घंटे" }`, or a single string when the language does not change.
- **`ctx::` prefixes** (`day::Mon`, `topic::fitment`, `dealer::Call`) name which meaning of a short English word is meant. Translate the meaning, without the prefix.
- **`app::` lines** (Hindi only) are the GridX app's own screens on the film's phone. They are copied from the app's Hindi (`gridxAppV3Sub-kunalmain2/lib/config/tranlation.dart`, the `hi_IN` map). Where the app has a line, use it word for word. Where it has none, write it as the app would. The iPhone's share sheet and WhatsApp screens are written as those apps show them in Hindi.

## 5. Fit

A translation never takes more room than the English where the design has none to give:
- **Top bar labels** (Home, Store, Dealers, Support): one short word, at most about 6 characters wide, since a phone gives each label 52px. Use what people say: होम, स्टोर, डीलर, मदद.
- **Buttons, step names and the configurator's footer** ("Continue", "Pay ₹399"): one line, as short as the English.
- **Film titles and captions:** no more lines than the English. A caption's parts (" | ") should each fit about 24 characters.
- **The "Click to experience" row and its three labels:** each label one or two short words; together they must fit a 320px phone.
- **Page titles** (`<title>`): under 60 characters, the brand part ("| GridX") kept in English.

## 6. Messages people send

WhatsApp messages the site prefills (asking a question, contacting a dealer, joining the dealer network) are written in the reader's own voice, the way they would type it to a business: friendly, first person, complete sentences. Order numbers, pincodes and names stay as they are.
