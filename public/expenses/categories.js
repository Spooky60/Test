// Category definitions and the rule-based categorizer.
// Keywords are matched case-insensitively against the transaction description
// (and the statement's own category/sector column when present).
// The longest matching keyword wins, so "uber eats" beats "uber".
(function (global) {
  "use strict";

  const CATEGORIES = [
    { id: "groceries", name: "Groceries", icon: "🛒", color: "#2f9e44",
      keywords: ["supermarket", "grocery", "groceries", "whole foods", "trader joe", "safeway", "kroger", "aldi", "lidl",
        "costco", "publix", "wegmans", "tesco", "sainsbury", "carrefour", "market", "שופרסל", "רמי לוי", "ויקטורי",
        "יוחננוף", "מגה בעיר", "טיב טעם", "אושר עד", "חצי חינם", "יינות ביתן", "am:pm", "סופרמרקט", "סופר ", "מכולת",
        "קרפור", "מעדניה", "ירקות", "פירות", "מאפיה", "קצביה", "מזון"] },
    { id: "dining", name: "Dining & Cafés", icon: "🍽️", color: "#e8590c",
      keywords: ["restaurant", "cafe", "café", "coffee", "starbucks", "mcdonald", "burger", "pizza", "sushi", "grill",
        "bistro", "kitchen", "diner", "bakery", "doordash", "uber eats", "ubereats", "grubhub", "deliveroo", "wolt",
        "10bis", "chipotle", "subway", "kfc", "domino", "taco", "bar", "pub", "תן ביס", "סיבוס", "cibus", "מסעדה", "מסעדת",
        "מסעדות", "קפה", "ארומה", "aroma", "גרג", "לנדוור", "מקדונלדס", "בורגר", "פיצה", "שווארמה", "פלאפל", "סושי",
        "בר", "פאב", "גלידה", "בית קפה", "וולט", "רולדין", "מזנון"] },
    { id: "transport", name: "Transport & Fuel", icon: "🚗", color: "#1971c2",
      keywords: ["uber", "lyft", "taxi", "gett", "gas station", "shell", "chevron", "exxon", "mobil", "bp", "parking",
        "toll", "transit", "metro", "rav kav", "pango", "cellopark", "fuel", "רב קו", "רב-קו", "פז ", "דלק", "סונול",
        "דור אלון", "תן דלק", "yellow", "חניה", "חניון", "פנגו", "סלופארק", "כביש 6", "כביש חוצה", "נתיבי איילון",
        "רכבת ישראל", "אגד", "מונית", "מוסך", "טסט", "צמיגים", "תחבורה", "רכב"] },
    { id: "travel", name: "Travel", icon: "✈️", color: "#0c8599",
      keywords: ["airline", "airlines", "airways", "el al", "booking.com", "airbnb", "expedia", "hotel", "hostel",
        "marriott", "hilton", "hyatt", "ryanair", "easyjet", "wizz", "lufthansa", "delta air", "united air",
        "american air", "hertz", "avis", "sixt", "europcar", "duty free", "אל על", "ישראייר", "ארקיע", "איסתא",
        "issta", "מלון", "נופש", "תיירות", "טיסה", "טיסות", "דיוטי פרי"] },
    { id: "shopping", name: "Shopping", icon: "🛍️", color: "#ae3ec9",
      keywords: ["amazon", "amzn", "aliexpress", "ebay", "shein", "temu", "zara", "h&m", "uniqlo", "ikea", "target",
        "walmart", "best buy", "apple store", "etsy", "asos", "next", "nike", "adidas", "mall", "ksp", "איקאה",
        "קסטרו", "castro", "פוקס", "fox", "טרמינל", "terminal x", "קניון", "הלבשה", "אופנה", "נעליים", "ביגוד",
        "מחשבים", "אלקטרוניקה", "באג", "מחסני חשמל", "שקם אלקטריק", "ריקושט", "גולף", "המשביר"] },
    { id: "subscriptions", name: "Subscriptions & Digital", icon: "📺", color: "#d6336c",
      keywords: ["netflix", "spotify", "disney", "hbo", "hulu", "apple.com", "itunes", "icloud", "google storage",
        "google one", "youtube", "prime video", "amazon prime", "dropbox", "adobe", "microsoft", "office 365",
        "openai", "chatgpt", "anthropic", "claude.ai", "github", "patreon", "audible", "kindle", "nordvpn", "canva",
        "notion", "zoom", "linkedin", "דיסני", "נטפליקס", "ספוטיפיי"] },
    { id: "utilities", name: "Bills & Utilities", icon: "💡", color: "#f08c00",
      keywords: ["electric", "electricity", "water", "internet", "broadband", "verizon", "at&t", "t-mobile", "comcast",
        "xfinity", "spectrum", "vodafone", "bezeq", "partner", "cellcom", "pelephone", "golan", "חברת החשמל",
        "חשמל", "בזק", "פרטנר", "סלקום", "הוט", "hot mobile", "גולן טלקום", "פלאפון", "012", "019", "ארנונה",
        "עירייה", "עיריית", "תאגיד מים", "מי ", "ועד בית", "סופרגז", "אמישראגז", "פזגז", "תקשורת"] },
    { id: "health", name: "Health & Pharmacy", icon: "💊", color: "#c92a2a",
      keywords: ["pharmacy", "cvs", "walgreens", "rite aid", "clinic", "doctor", "medical", "dental", "dentist",
        "hospital", "optical", "optic", "super-pharm", "super pharm", "סופר פארם", "סופר-פארם", "ניו פארם", "be ",
        "מכבי", "כללית", "מאוחדת", "לאומית", "בית מרקחת", "פארם", "אופטיקה", "רופא", "מרפאה", "שיניים", "בית חולים",
        "רפואה", "רפואי"] },
    { id: "fitness", name: "Fitness & Wellness", icon: "🏋️", color: "#5c940d",
      keywords: ["gym", "fitness", "yoga", "pilates", "crossfit", "planet fitness", "equinox", "holmes place",
        "הולמס", "חדר כושר", "כושר", "יוגה", "פילאטיס", "ספורט", "בריכה", "קאנטרי"] },
    { id: "entertainment", name: "Entertainment", icon: "🎬", color: "#7048e8",
      keywords: ["cinema", "movie", "theater", "theatre", "ticketmaster", "eventim", "tickets", "steam", "playstation",
        "xbox", "nintendo", "museum", "bowling", "concert", "yes planet", "cinema city", "סינמה", "יס פלאנט",
        "קולנוע", "תיאטרון", "הופעה", "כרטיסים", "לאן", "מוזיאון", "פנאי", "בילוי"] },
    { id: "home", name: "Home & Garden", icon: "🏠", color: "#8f5d2a",
      keywords: ["home depot", "lowe's", "lowes", "ace hardware", "bed bath", "wayfair", "furniture", "hardware",
        "home center", "הום סנטר", "אייס", "ace", "טמבור", "רהיטים", "ריהוט", "כלי בית", "נגריה", "אינסטלטור",
        "משתלה", "גינון", "ניקיון", "שיפוצים", "הום"] },
    { id: "education", name: "Education & Books", icon: "📚", color: "#3b5bdb",
      keywords: ["university", "college", "school", "tuition", "course", "udemy", "coursera", "books", "bookstore",
        "barnes", "steimatzky", "סטימצקי", "צומת ספרים", "ספרים", "אוניברסיטה", "מכללה", "בית ספר", "קורס",
        "שכר לימוד", "חוג", "חוגים"] },
    { id: "kids", name: "Kids & Family", icon: "🧸", color: "#f783ac",
      keywords: ["toys", "toy", "kids", "baby", "babies", "daycare", "kindergarten", "צעצועים", "שילב", "גן ילדים",
        "מעון", "צהרון", "תינוקות", "ילדים", "טויס"] },
    { id: "personal", name: "Personal Care", icon: "💇", color: "#e64980",
      keywords: ["salon", "barber", "hair", "nails", "sephora", "ulta", "cosmetics", "beauty", "מספרה", "קוסמטיקה",
        "יופי", "מניקור", "ספא", "spa", "בשמים", "טיפוח"] },
    { id: "pets", name: "Pets", icon: "🐾", color: "#a9743a",
      keywords: ["pet", "petco", "petsmart", "vet", "veterinary", "chewy", "וטרינר", "חיות", "פט שופ", "zoo"] },
    { id: "insurance", name: "Insurance", icon: "🛡️", color: "#495057",
      keywords: ["insurance", "geico", "progressive", "allstate", "state farm", "ביטוח", "הראל", "מגדל", "הפניקס",
        "כלל ביטוח", "מנורה", "איילון", "שירביט", "ביטוח ישיר", "aig", "ליברה", "wesure"] },
    { id: "fees", name: "Fees & Interest", icon: "🏦", color: "#868e96",
      keywords: ["fee", "fees", "interest", "finance charge", "late charge", "annual fee", "foreign transaction",
        "עמלה", "עמלת", "דמי כרטיס", "ריבית", "דמי ניהול", "דמי חבר"] },
    { id: "transfers", name: "Cash & Transfers", icon: "💸", color: "#15aabf",
      keywords: ["atm", "cash withdrawal", "paypal", "venmo", "zelle", "cash app", "bit ", "paybox", "משיכת מזומן",
        "כספומט", "ביט", "פייבוקס", "העברה"] },
    { id: "donations", name: "Donations", icon: "🎗️", color: "#82c91e",
      keywords: ["donation", "charity", "foundation", "תרומה", "תרומות", "עמותה", "עמותת"] },
    { id: "payment", name: "Card Payments", icon: "↩️", color: "#adb5bd", excluded: true,
      keywords: ["payment thank you", "payment - thank you", "autopay", "auto pay", "online payment", "payment received",
        "תשלום לכרטיס", "פירעון"] },
    { id: "other", name: "Other", icon: "📦", color: "#748ffc", keywords: [] },
  ];

  const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

  const LETTER = /[\p{L}\p{N}]/u;

  // Short keywords (and ones written with a trailing space) must match a whole
  // word so "bar" doesn't match "barnes"; longer ones match anywhere.
  function matches(text, kw) {
    const raw = kw.toLowerCase();
    const k = raw.trim();
    if (k.length > 4 && raw === k) return text.includes(k);
    let from = 0;
    while (true) {
      const i = text.indexOf(k, from);
      if (i < 0) return false;
      const before = i === 0 ? "" : text[i - 1];
      const after = text[i + k.length] || "";
      if (!LETTER.test(before) && !LETTER.test(after)) return true;
      from = i + 1;
    }
  }

  // Precompute a flat keyword list sorted longest-first.
  const KEYWORDS = [];
  CATEGORIES.forEach((c, order) =>
    c.keywords.forEach((k) => KEYWORDS.push({ k, cat: c.id, order, len: k.trim().length }))
  );
  KEYWORDS.sort((a, b) => b.len - a.len || a.order - b.order);

  function matchKeywords(text) {
    if (!text) return null;
    const t = " " + String(text).toLowerCase().replace(/[\s*_]+/g, " ") + " ";
    for (const entry of KEYWORDS) if (matches(t, entry.k)) return entry.cat;
    return null;
  }

  /** Normalize a raw description into a stable merchant key. */
  function merchantKey(desc) {
    return String(desc || "")
      .toLowerCase()
      .replace(/^(sq|tst|sp|pp|paypal|pos|ach|dd|chk)\s*\*\s*/i, "")
      .replace(/\*/g, " ")
      .replace(/\b(www\.|\.com|\.co\.il|\.net)\b/g, "")
      .replace(/#?\d{3,}/g, " ")
      .replace(/[^\p{L}\p{N}&' ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 4)
      .join(" ") || "unknown";
  }

  /**
   * Categorize a transaction. Order: user rules → keywords on the description →
   * keywords on the statement's own category column → sign-based fallback.
   */
  function categorize(tx, rules) {
    const key = tx.merchant || merchantKey(tx.description);
    const desc = (tx.description || "").toLowerCase();
    for (const r of rules || []) {
      const p = r.pattern.toLowerCase();
      if (key === p || (p.length >= 3 && desc.includes(p))) return r.category;
    }
    return matchKeywords(tx.description) || matchKeywords(tx.hint) || "other";
  }

  global.Categories = { CATEGORIES, BY_ID, categorize, merchantKey, matchKeywords };
})(window);
