/*
 * The site's languages, as the build and the checks need them. What a page needs at runtime
 * (the picker's names, the letters, which pages are translated) is in assets/i18n.js, and
 * tools/check/i18n.mjs holds the two to the same codes.
 *
 * app: whether the GridX app speaks the language. The film's phone (data-i18n="app" in
 * index.html) shows the app as it really is, so it is translated only where the app is:
 * Hindi, from the app's own strings. Everywhere else it stays the English app.
 *
 * banned: words the house rules keep out (STYLE.md): any word for a reservation (customers
 * pre-book), and "small" for the team (it is lean).
 */
export const PAGES_IN_EVERY_LANGUAGE = [
  'index.html', 'store.html', 'powerpod-gen2.html', 'adapter.html', 'chargers.html',
  'vehicle-dock.html', 'dealers.html', 'support.html', 'journey.html', '404.html', 'better.html',
];

const EVERY = ['\u2014', 'reserve', 'reservation', 'Reserve', 'Reservation'];

export const LANGUAGES = {
  hi: {
    letter: 'अ', name: 'हिंदी', gloss: 'Hindi', hreflang: 'hi-IN', ogLocale: 'hi_IN', script: 'Devanagari', app: true,
    digits: /[०-९]/,
    banned: [...EVERY, 'आरक्षण', 'रिज़र्व', 'रिजर्व', 'छोटी टीम', 'छोटी सी टीम'],
  },
  mr: {
    letter: 'अ', name: 'मराठी', gloss: 'Marathi', hreflang: 'mr-IN', ogLocale: 'mr_IN', script: 'Devanagari', app: false,
    digits: /[०-९]/,
    banned: [...EVERY, 'आरक्षण', 'राखीव', 'रिझर्व्ह', 'छोटी टीम', 'लहान टीम'],
  },
  bn: {
    letter: 'অ', name: 'বাংলা', gloss: 'Bengali', hreflang: 'bn-IN', ogLocale: 'bn_IN', script: 'Bengali', app: false,
    digits: /[০-৯]/,
    banned: [...EVERY, 'সংরক্ষণ', 'রিজার্ভ', 'ছোট দল', 'ছোট টিম'],
  },
  kn: {
    letter: 'ಅ', name: 'ಕನ್ನಡ', gloss: 'Kannada', hreflang: 'kn-IN', ogLocale: 'kn_IN', script: 'Kannada', app: false,
    digits: /[೦-೯]/,
    banned: [...EVERY, 'ಕಾಯ್ದಿರಿಸು', 'ಕಾಯ್ದಿರಿಸಿ', 'ರಿಸರ್ವ್', 'ಸಣ್ಣ ತಂಡ', 'ಚಿಕ್ಕ ತಂಡ'],
  },
  te: {
    letter: 'అ', name: 'తెలుగు', gloss: 'Telugu', hreflang: 'te-IN', ogLocale: 'te_IN', script: 'Telugu', app: false,
    digits: /[౦-౯]/,
    banned: [...EVERY, 'రిజర్వ్', 'రిజర్వేషన్', 'చిన్న బృందం', 'చిన్న టీమ్'],
  },
};

export const LANGS = Object.keys(LANGUAGES);

// Never shipped: tools/i18n.mjs makes it up from the English, longer and in Devanagari, so
// every layout check can run before a single word is translated. Served as /qps/ in dev.
export const PSEUDO = 'qps';

// Names that stay in Latin script in every language, and must survive any translation that
// carries them.
export const BRANDS = ['GridXenergy', 'GridX', 'PowerPod', 'Gen1', 'Gen2', 'Komaki', 'X1', 'X3', 'WhatsApp', 'SOS', 'GPS', 'kWh', 'Bluetooth'];

// People named on the pages: in Latin script, exactly as the English writes them, in every
// language (a transliteration can misspell a name, and a name is a fact). The film's phone
// names its demo contacts too.
export const NAMES = ['Vishrut', 'Vatsa', 'Shivanshu', 'Mahim', 'Paridhi', 'Sinha', 'Hriteek', 'Agrawal',
  'Chetan Maini', 'Anand Ganapathy Chennira', 'Aarav', 'Meera'];
