/**
 * ask_otp — pause the agent and wait for a human OTP / verification code.
 *
 * Use ONLY when a real code was just sent during this work (email/SMS/app)
 * and the human did not already paste it. Not for inventing codes.
 *
 * Also generates disposable identity (email / phone / name) when the site
 * needs signup fields the user never provided — so the agent does not ask
 * for those; it only pauses for the OTP itself.
 */

const crypto = require("crypto");

// ── @faker-js/faker — large realistic name + address corpora (70+ locales) ─
// Prefer Faker for names/addresses; tiny local lists remain only as hard fallback.
let _fakerPkg = null;
function loadFakerPkg() {
  if (_fakerPkg) return _fakerPkg;
  try {
    _fakerPkg = require("@faker-js/faker");
  } catch {
    _fakerPkg = null;
  }
  return _fakerPkg;
}

/** Map our country codes → faker locale instance (large built-in name/address banks). */
function getFakerForCountry(country) {
  const pkg = loadFakerPkg();
  if (!pkg) return null;
  const cc = normalizeCountry(country);
  const map = {
    us: pkg.fakerEN_US || pkg.fakerEN || pkg.faker,
    ca: pkg.fakerEN_CA || pkg.fakerEN || pkg.faker,
    uk: pkg.fakerEN_GB || pkg.fakerEN || pkg.faker,
    gb: pkg.fakerEN_GB || pkg.fakerEN || pkg.faker,
    de: pkg.fakerDE || pkg.faker,
    fr: pkg.fakerFR || pkg.faker,
    es: pkg.fakerES || pkg.faker,
    ru: pkg.fakerRU || pkg.faker,
    br: pkg.fakerPT_BR || pkg.faker,
    in: pkg.fakerEN_IN || pkg.fakerEN || pkg.faker,
    pl: pkg.fakerPL || pkg.faker,
    nl: pkg.fakerNL || pkg.faker,
    it: pkg.fakerIT || pkg.faker,
    ua: pkg.fakerUK || pkg.fakerRU || pkg.faker, // Ukrainian locale in faker is fakerUK
  };
  const f = map[cc] || pkg.fakerEN_US || pkg.faker;
  // Fresh entropy each call so batch units don't share sequences
  try {
    f.seed(crypto.randomInt(1, 0x7fffffff));
  } catch {
    /* optional */
  }
  return f;
}

// Tiny fallback banks (only if @faker-js/faker missing)
const FIRST_NAMES = {
  us: ["James", "Emma", "Liam", "Olivia", "Noah", "Ava", "Mason", "Sophia", "Ethan", "Mia"],
  uk: ["Oliver", "Amelia", "Harry", "Isla", "Jack", "Emily", "George", "Poppy", "Charlie", "Lily"],
  de: ["Lukas", "Mia", "Leon", "Emma", "Paul", "Hannah", "Finn", "Sofia", "Jonas", "Lina"],
  fr: ["Louis", "Emma", "Hugo", "Jade", "Lucas", "Louise", "Gabriel", "Alice", "Arthur", "Chloé"],
  es: ["Hugo", "Lucía", "Martín", "Sofía", "Pablo", "María", "Daniel", "Valeria", "Alejandro", "Paula"],
  ru: ["Ivan", "Anna", "Dmitry", "Maria", "Alexey", "Elena", "Sergey", "Olga", "Nikita", "Natalia"],
  br: ["João", "Maria", "Pedro", "Ana", "Lucas", "Julia", "Gabriel", "Beatriz", "Matheus", "Larissa"],
  in: ["Aarav", "Ananya", "Vivaan", "Diya", "Aditya", "Isha", "Arjun", "Kiara", "Rohan", "Myra"],
  default: ["Alex", "Sam", "Jordan", "Taylor", "Casey", "Riley", "Morgan", "Avery", "Quinn", "Jamie"],
};

const LAST_NAMES = {
  us: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Moore"],
  uk: ["Smith", "Jones", "Taylor", "Brown", "Williams", "Wilson", "Johnson", "Davies", "Patel", "Wright"],
  de: ["Müller", "Schmidt", "Schneider", "Fischer", "Weber", "Meyer", "Wagner", "Becker", "Schulz", "Hoffmann"],
  fr: ["Martin", "Bernard", "Dubois", "Thomas", "Robert", "Richard", "Petit", "Durand", "Leroy", "Moreau"],
  es: ["García", "Rodríguez", "González", "Fernández", "López", "Martínez", "Sánchez", "Pérez", "Gómez", "Martin"],
  ru: ["Ivanov", "Smirnov", "Kuznetsov", "Popov", "Sokolov", "Lebedev", "Kozlov", "Novikov", "Morozov", "Petrov"],
  br: ["Silva", "Santos", "Oliveira", "Souza", "Rodrigues", "Ferreira", "Alves", "Pereira", "Lima", "Gomes"],
  in: ["Sharma", "Patel", "Singh", "Kumar", "Gupta", "Shah", "Reddy", "Nair", "Mehta", "Joshi"],
  default: ["Stone", "Reed", "Brooks", "Hayes", "Cole", "Gray", "West", "Lane", "Fox", "Hunt"],
};

/** Country / locale → phone prefix + length of national number (digits after dial code) */
const PHONE_RULES = {
  us: { dial: "+1", nsn: 10, mask: (d) => `+1${d}` },
  ca: { dial: "+1", nsn: 10, mask: (d) => `+1${d}` },
  uk: { dial: "+44", nsn: 10, mask: (d) => `+44${d}` },
  gb: { dial: "+44", nsn: 10, mask: (d) => `+44${d}` },
  de: { dial: "+49", nsn: 11, mask: (d) => `+49${d}` },
  fr: { dial: "+33", nsn: 9, mask: (d) => `+33${d}` },
  es: { dial: "+34", nsn: 9, mask: (d) => `+34${d}` },
  ru: { dial: "+7", nsn: 10, mask: (d) => `+7${d}` },
  br: { dial: "+55", nsn: 11, mask: (d) => `+55${d}` },
  in: { dial: "+91", nsn: 10, mask: (d) => `+91${d}` },
  pl: { dial: "+48", nsn: 9, mask: (d) => `+48${d}` },
  nl: { dial: "+31", nsn: 9, mask: (d) => `+31${d}` },
  it: { dial: "+39", nsn: 10, mask: (d) => `+39${d}` },
  ua: { dial: "+380", nsn: 9, mask: (d) => `+380${d}` },
  default: { dial: "+1", nsn: 10, mask: (d) => `+1${d}` },
};

const EMAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "yahoo.com",
  "proton.me",
  "icloud.com",
  "hotmail.com",
  "mail.com",
  "gmx.com",
];

function rnd(n) {
  return crypto.randomInt(0, Math.max(1, n));
}

function pick(arr) {
  return arr[rnd(arr.length)];
}

function digits(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String(crypto.randomInt(0, 10));
  return s;
}

function slug(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 16);
}

/**
 * Strong password for signup forms (passes most site policies):
 * - length 14–16 (default 16)
 * - ≥1 upper, ≥1 lower, ≥1 digit, ≥1 symbol
 * - no spaces, no ambiguous O/0/l/1/I if avoidAmbiguous
 * - not derived from name/email (no dictionary-ish prefixes)
 * - symbols from a safe set that sites usually accept: !@#$%^&*_-+
 */
function generatePassword(opts = {}) {
  const length = Math.max(12, Math.min(32, Number(opts.length) || 16));
  const lower = "abcdefghjkmnpqrstuvwxyz"; // no i/l
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/O
  const nums = "23456789"; // no 0/1
  // Avoid quotes/backslashes/spaces which break HTML forms or shell copy
  const symbols = "!@#$%^&*_-+=";
  const all = lower + upper + nums + symbols;

  // Guarantee one of each class first, then fill
  const required = [
    upper[rnd(upper.length)],
    lower[rnd(lower.length)],
    nums[rnd(nums.length)],
    symbols[rnd(symbols.length)],
  ];
  const chars = required.slice();
  while (chars.length < length) {
    chars.push(all[rnd(all.length)]);
  }
  // Fisher–Yates shuffle (crypto)
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const t = chars[i];
    chars[i] = chars[j];
    chars[j] = t;
  }
  // Ensure not starting with a symbol (some sites reject) — swap first with a letter if needed
  if (!/[A-Za-z]/.test(chars[0])) {
    const letterIdx = chars.findIndex((c) => /[A-Za-z]/.test(c));
    if (letterIdx > 0) {
      const t = chars[0];
      chars[0] = chars[letterIdx];
      chars[letterIdx] = t;
    } else {
      chars[0] = upper[rnd(upper.length)];
    }
  }
  return chars.join("");
}

/** Quick policy check used in tests / agent notes */
function passwordLooksStrong(pw) {
  const s = String(pw || "");
  return (
    s.length >= 12 &&
    /[A-Z]/.test(s) &&
    /[a-z]/.test(s) &&
    /\d/.test(s) &&
    /[!@#$%^&*_\-+=]/.test(s) &&
    !/\s/.test(s)
  );
}

function normalizeCountry(raw) {
  const c = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const map = {
    usa: "us",
    america: "us",
    unitedstates: "us",
    england: "uk",
    britain: "uk",
    unitedkingdom: "uk",
    germany: "de",
    deutschland: "de",
    france: "fr",
    spain: "es",
    espana: "es",
    russia: "ru",
    brazil: "br",
    brasil: "br",
    india: "in",
    poland: "pl",
    netherlands: "nl",
    holland: "nl",
    italy: "it",
    ukraine: "ua",
    canada: "ca",
  };
  if (map[c]) return map[c];
  if (PHONE_RULES[c]) return c;
  if (FIRST_NAMES[c]) return c;
  return c || "us";
}

function generateName(country) {
  const cc = normalizeCountry(country);
  const f = getFakerForCountry(cc);
  if (f?.person) {
    try {
      // Large locale-specific first/last banks from @faker-js/faker
      let first = String(f.person.firstName() || "").trim();
      let last = String(f.person.lastName() || "").trim();
      // Strip multi-word oddities / keep form-friendly single tokens when possible
      first = first.split(/\s+/)[0] || first;
      last = last.replace(/^de\s+|^van\s+|^von\s+/i, "").trim() || last;
      if (first && last) {
        return {
          first_name: first,
          last_name: last,
          full_name: `${first} ${last}`,
          country: cc,
          source: "faker",
        };
      }
    } catch {
      /* fall through */
    }
  }
  const first = pick(FIRST_NAMES[cc] || FIRST_NAMES.default);
  const last = pick(LAST_NAMES[cc] || LAST_NAMES.default);
  return {
    first_name: first,
    last_name: last,
    full_name: `${first} ${last}`,
    country: cc,
    source: "fallback",
  };
}

function generateEmail(opts = {}) {
  const name = opts.first_name || opts.last_name ? opts : generateName(opts.country);
  const a = slug(name.first_name || "user") || "user";
  const b = slug(name.last_name || "mail") || "mail";
  const n = digits(3 + rnd(3));
  const styles = [
    `${a}.${b}${n}`,
    `${a}${b}${n}`,
    `${a}_${b}${n}`,
    `${a}${digits(4)}`,
    `${b}.${a}${digits(2)}`,
  ];
  const local = pick(styles);
  const domain = opts.domain || pick(EMAIL_DOMAINS);
  return {
    email: `${local}@${domain}`,
    first_name: name.first_name,
    last_name: name.last_name,
    full_name: name.full_name,
    country: name.country || normalizeCountry(opts.country),
  };
}

function generatePhone(country) {
  const cc = normalizeCountry(country);
  const rule = PHONE_RULES[cc] || PHONE_RULES.default;
  // Avoid leading 0 on national numbers where awkward
  let nsn = digits(rule.nsn);
  if (nsn[0] === "0") nsn = String(1 + rnd(9)) + nsn.slice(1);
  // US/CA: NXX NXX XXXX with valid NPA-ish first digit 2-9
  if ((cc === "us" || cc === "ca") && nsn.length >= 10) {
    const a = String(2 + rnd(8));
    const b = String(2 + rnd(8));
    nsn = a + nsn.slice(1, 3) + b + nsn.slice(4);
  }
  const e164 = rule.mask(nsn);
  return {
    phone: e164,
    phone_national: nsn,
    dial_code: rule.dial,
    country: cc,
  };
}

/** Cities / streets / postal patterns per country for form fill */
const ADDRESS_DATA = {
  us: {
    cities: [
      { city: "Austin", state: "TX", zip: () => `78${digits(3)}` },
      { city: "Denver", state: "CO", zip: () => `80${digits(3)}` },
      { city: "Seattle", state: "WA", zip: () => `98${digits(3)}` },
      { city: "Chicago", state: "IL", zip: () => `60${digits(3)}` },
      { city: "Miami", state: "FL", zip: () => `33${digits(3)}` },
    ],
    streets: ["Oak", "Maple", "Cedar", "Pine", "Lake", "Hill", "Park", "River"],
    types: ["St", "Ave", "Rd", "Dr", "Blvd", "Ln"],
  },
  uk: {
    cities: [
      { city: "London", state: "", zip: () => `SW${1 + rnd(9)} ${1 + rnd(9)}AA` },
      { city: "Manchester", state: "", zip: () => `M${1 + rnd(9)} ${1 + rnd(9)}AB` },
      { city: "Bristol", state: "", zip: () => `BS${1 + rnd(9)} ${1 + rnd(9)}CD` },
    ],
    streets: ["High", "Church", "Station", "Victoria", "King", "Queen"],
    types: ["Street", "Road", "Lane", "Avenue", "Close"],
  },
  de: {
    cities: [
      { city: "Berlin", state: "BE", zip: () => `10${digits(3)}` },
      { city: "München", state: "BY", zip: () => `80${digits(3)}` },
      { city: "Hamburg", state: "HH", zip: () => `20${digits(3)}` },
    ],
    streets: ["Haupt", "Bahnhof", "Garten", "Wald", "Kirch", "Schul"],
    types: ["straße", "weg", "allee", "platz"],
  },
  fr: {
    cities: [
      { city: "Paris", state: "", zip: () => `75${String(1 + rnd(20)).padStart(3, "0")}` },
      { city: "Lyon", state: "", zip: () => `69${digits(3)}` },
      { city: "Marseille", state: "", zip: () => `13${digits(3)}` },
    ],
    streets: ["Victor Hugo", "de la République", "des Lilas", "Pasteur"],
    types: ["Rue", "Avenue", "Boulevard", "Allée"],
  },
  es: {
    cities: [
      { city: "Madrid", state: "MD", zip: () => `28${digits(3)}` },
      { city: "Barcelona", state: "CT", zip: () => `08${digits(3)}` },
      { city: "Valencia", state: "VC", zip: () => `46${digits(3)}` },
    ],
    streets: ["Mayor", "de la Paz", "del Sol", "Gran Vía"],
    types: ["Calle", "Avenida", "Paseo", "Plaza"],
  },
  ru: {
    cities: [
      { city: "Moscow", state: "", zip: () => `1${digits(5)}` },
      { city: "Saint Petersburg", state: "", zip: () => `19${digits(4)}` },
      { city: "Kazan", state: "", zip: () => `42${digits(4)}` },
    ],
    streets: ["Lenina", "Pushkina", "Mir", "Sovetskaya", "Gagarina"],
    types: ["ul.", "pr.", "per."],
  },
  br: {
    cities: [
      { city: "São Paulo", state: "SP", zip: () => `${digits(5)}-${digits(3)}` },
      { city: "Rio de Janeiro", state: "RJ", zip: () => `${digits(5)}-${digits(3)}` },
    ],
    streets: ["das Flores", "Brasil", "Paulista", "do Sol"],
    types: ["Rua", "Avenida", "Travessa"],
  },
  in: {
    cities: [
      { city: "Mumbai", state: "MH", zip: () => `40${digits(4)}` },
      { city: "Bengaluru", state: "KA", zip: () => `56${digits(4)}` },
      { city: "Delhi", state: "DL", zip: () => `11${digits(4)}` },
    ],
    streets: ["MG Road", "Park", "Station", "Gandhi"],
    types: ["Road", "Street", "Nagar", "Marg"],
  },
  default: {
    cities: [{ city: "Springfield", state: "IL", zip: () => `62${digits(3)}` }],
    streets: ["Main", "Oak", "First", "Second"],
    types: ["St", "Ave", "Rd"],
  },
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

const MONTH_NAMES_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Adult DOB: age **21+** by default (signup / alcohol-age safe).
 * Guarantees the person has ALREADY turned minAge today (not just year math).
 * Extra fields for dropdowns: year string, month name, padded day/month.
 * Returns iso (YYYY-MM-DD), us (MM/DD/YYYY), eu (DD.MM.YYYY), year/month/day, age.
 */
function generateDob(input = {}) {
  // Default floor 21 (not 18) so 21+ site policies / year dropdowns pass
  const minAge = Math.max(21, Number(input.min_age || input.minAge) || 21);
  const maxAge = Math.min(70, Number(input.max_age || input.maxAge) || 45);
  const lo = Math.min(minAge, maxAge);
  const hi = Math.max(minAge, maxAge);
  const targetAge = lo + rnd(hi - lo + 1);
  const now = new Date();
  // Birthday already passed this year → true age = targetAge
  // Pick month/day strictly BEFORE today (or equal with earlier time → still ok)
  // Safer: birthday between Jan 1 and yesterday (or Jan 1 if early Jan)
  let month;
  let day;
  const todayM = now.getMonth() + 1; // 1-12
  const todayD = now.getDate();
  if (todayM === 1 && todayD === 1) {
    // edge: use Dec 31 of previous calendar year → age = targetAge still via year adjust
    month = 12;
    day = 31;
  } else {
    // random date from Jan 1 through yesterday
    const yday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const start = new Date(now.getFullYear(), 0, 1);
    const spanDays = Math.max(
      1,
      Math.floor((yday.getTime() - start.getTime()) / 86400000) + 1
    );
    const offset = rnd(spanDays);
    const bdayThisYear = new Date(now.getFullYear(), 0, 1 + offset);
    month = bdayThisYear.getMonth() + 1;
    day = bdayThisYear.getDate();
  }
  // year such that age today === targetAge (birthday already occurred)
  let year = now.getFullYear() - targetAge;
  // If we had to use Dec 31 on Jan 1 edge, year was already past
  const dim = new Date(year, month, 0).getDate();
  if (day > dim) day = dim;
  // Verify chronological age ≥ minAge; bump year older if needed
  let age = targetAge;
  const born = new Date(year, month - 1, day);
  let years =
    now.getFullYear() -
    born.getFullYear() -
    (now < new Date(now.getFullYear(), born.getMonth(), born.getDate()) ? 1 : 0);
  while (years < minAge && year > 1940) {
    year -= 1;
    years += 1;
    age = years;
  }
  age = years;
  if (age < minAge) {
    // hard fallback: fixed 25yo Jan 15
    year = now.getFullYear() - Math.max(25, minAge);
    month = 1;
    day = 15;
    age = Math.max(25, minAge);
  }
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const monthName = MONTH_NAMES_EN[month - 1] || "January";
  const monthShort = MONTH_NAMES_SHORT[month - 1] || "Jan";
  return {
    birth_date: iso,
    birth_date_iso: iso,
    birth_date_us: `${pad2(month)}/${pad2(day)}/${year}`,
    birth_date_eu: `${pad2(day)}.${pad2(month)}.${year}`,
    // numeric + string forms for <select> / dropdowns
    birth_year: year,
    birth_year_str: String(year),
    birth_month: month,
    birth_month_str: pad2(month),
    birth_month_name: monthName,
    birth_month_short: monthShort,
    birth_day: day,
    birth_day_str: pad2(day),
    // convenience aliases agents use when filling Year / Month / Day selects
    year: year,
    year_str: String(year),
    month: month,
    month_str: pad2(month),
    month_name: monthName,
    day: day,
    day_str: pad2(day),
    age,
    min_age_policy: minAge,
    note:
      `Age ${age} (21+ policy). For dropdowns: Year=${year}, Month=${monthName} (${pad2(month)}), Day=${pad2(day)}. ` +
      "Always pick year so person is 21 or older — never underage years.",
  };
}

function generateAddress(country) {
  const cc = normalizeCountry(country);
  const f = getFakerForCountry(cc);
  if (f?.location) {
    try {
      const line1 = String(
        f.location.streetAddress({ useFullAddress: false }) || f.location.streetAddress() || ""
      ).trim();
      const city = String(f.location.city() || "").trim();
      let state = "";
      try {
        state = String(f.location.state({ abbreviated: true }) || f.location.state() || "").trim();
      } catch {
        try {
          state = String(f.location.state() || "").trim();
        } catch {
          state = "";
        }
      }
      // Some locales have no state — use county / empty
      if (!state) {
        try {
          state = String(f.location.county?.() || "").trim();
        } catch {
          /* */
        }
      }
      let zip = "";
      try {
        zip = String(f.location.zipCode() || "").trim();
      } catch {
        zip = digits(5);
      }
      const line2 =
        rnd(4) === 0
          ? String(
              f.location.secondaryAddress?.() ||
                `Apt ${1 + rnd(40)}${String.fromCharCode(65 + rnd(4))}`
            )
          : "";
      if (line1 && city) {
        return {
          address_line1: line1,
          address_line2: line2,
          street: line1,
          city,
          state: state || "",
          region: state || "",
          postal_code: zip || digits(5),
          zip: zip || digits(5),
          country: cc,
          country_code: cc.toUpperCase() === "UK" ? "GB" : cc.toUpperCase(),
          source: "faker",
        };
      }
    } catch {
      /* fall through to small pack */
    }
  }
  // Fallback: small embedded city/street packs
  const pack = ADDRESS_DATA[cc] || ADDRESS_DATA.default;
  const place = pick(pack.cities);
  const num = 1 + rnd(9999);
  const streetName = pick(pack.streets);
  const streetType = pick(pack.types);
  let line1;
  if (cc === "de") {
    line1 = `${streetName}${streetType} ${num}`;
  } else if (cc === "fr" || cc === "es" || cc === "br") {
    line1 = `${streetType} ${streetName} ${num}`;
  } else if (cc === "ru") {
    line1 = `${streetType} ${streetName}, d. ${num}`;
  } else {
    line1 = `${num} ${streetName} ${streetType}`;
  }
  const zip = typeof place.zip === "function" ? place.zip() : String(place.zip || digits(5));
  const line2 = rnd(3) === 0 ? `Apt ${1 + rnd(40)}${String.fromCharCode(65 + rnd(4))}` : "";
  return {
    address_line1: line1,
    address_line2: line2,
    street: line1,
    city: place.city,
    state: place.state || "",
    region: place.state || "",
    postal_code: zip,
    zip,
    country: cc,
    country_code: cc.toUpperCase() === "UK" ? "GB" : cc.toUpperCase(),
    source: "fallback",
  };
}

function generateGender() {
  // binary + prefer not to say for forms that need a value
  return pick(["male", "female", "male", "female", "other"]);
}

function generateIdentity(input = {}) {
  const country = normalizeCountry(input.country || input.locale || "us");
  const name = generateName(country);
  const email = generateEmail({ ...name, country, domain: input.email_domain });
  const phone = generatePhone(country);
  const dob = generateDob(input);
  const address = generateAddress(country);
  const gender = generateGender();
  const username =
    slug(name.first_name) +
    slug(name.last_name).slice(0, 4) +
    digits(2 + rnd(2));
  // Strong random — NOT based on name (sites reject "emmaA1234!" style / weak patterns)
  const password = generatePassword({ length: 16 });
  return {
    country,
    first_name: name.first_name,
    last_name: name.last_name,
    full_name: name.full_name,
    email: email.email,
    phone: phone.phone,
    phone_national: phone.phone_national,
    dial_code: phone.dial_code,
    username,
    password,
    gender,
    // DOB (always 21+; fields for text + Year/Month/Day dropdowns)
    birth_date: dob.birth_date,
    birth_date_iso: dob.birth_date_iso,
    birth_date_us: dob.birth_date_us,
    birth_date_eu: dob.birth_date_eu,
    birth_year: dob.birth_year,
    birth_year_str: dob.birth_year_str,
    birth_month: dob.birth_month,
    birth_month_str: dob.birth_month_str,
    birth_month_name: dob.birth_month_name,
    birth_month_short: dob.birth_month_short,
    birth_day: dob.birth_day,
    birth_day_str: dob.birth_day_str,
    // short aliases for select options
    year: dob.year,
    year_str: dob.year_str,
    month: dob.month,
    month_str: dob.month_str,
    month_name: dob.month_name,
    day: dob.day,
    day_str: dob.day_str,
    age: dob.age,
    // Address
    address_line1: address.address_line1,
    address_line2: address.address_line2,
    street: address.street,
    city: address.city,
    state: address.state,
    region: address.region,
    postal_code: address.postal_code,
    zip: address.zip,
    country_code: address.country_code,
    name_source: name.source || "faker",
    address_source: address.source || "faker",
    note:
      "Synthetic identity for this session only — auto-fill ALL form fields yourself. " +
      "Do NOT ask the human for name/DOB/address/email/phone/password. " +
      "Names+addresses from @faker-js/faker (large locale banks). " +
      "Password is strong (16 chars, upper+lower+digit+symbol) — use as-is, keep same for the account. " +
      `DOB age=${dob.age} (21+). Dropdowns: Year=${dob.year_str} Month=${dob.month_name} (${dob.month_str}) Day=${dob.day_str}. ` +
      "Never pick underage years. Only pause with ask_otp wait when a real OTP was just sent.",
  };
}

function buildPrompt(kind, meta = {}) {
  const k = String(kind || "otp").toLowerCase();
  const dest = meta.destination || meta.to || meta.email || meta.phone || "";
  const site = meta.site || meta.service || meta.context || "";
  const parts = [];
  if (k === "email" || k === "mail") {
    parts.push("📧 Email verification code");
  } else if (k === "sms" || k === "phone" || k === "call") {
    parts.push("📱 SMS / phone code");
  } else if (k === "app" || k === "totp" || k === "2fa") {
    parts.push("🔐 App / 2FA code");
  } else {
    parts.push("🔑 Verification code (OTP)");
  }
  if (site) parts.push(`· ${site}`);
  let q = parts.join(" ");
  if (dest) q += `\nSent to: ${dest}`;
  if (meta.hint) q += `\n${meta.hint}`;
  q += "\n\nPaste the code below — agent will continue automatically.";
  return q;
}

module.exports = {
  name: "ask_otp",
  description:
    "OTP pause + full signup identity auto-generation for form fill during automation.\n\n" +
    "POLICY: During signup/login forms, DO NOT ask the human for name, DOB, address, email, phone, " +
    "username, password, gender, or other profile fields they never provided. " +
    "Call generate_identity (or generate_*) yourself and fill the form. " +
    "ONLY pause the human for a real OTP/verification code that was just sent in THIS work.\n\n" +
    "Identity helpers (no pause) — use proactively mid-task:\n" +
    "- generate_identity — full pack: name, email, phone, DOB, address, city/state/zip, gender, username, password\n" +
    "- generate_email | generate_phone | generate_name | generate_dob | generate_address | generate_password — single field packs\n" +
    "Pass country/locale when known (us, uk, de, fr, es, ru, br, in, …).\n" +
    "Names + addresses use @faker-js/faker (huge multi-locale first/last name + street/city/zip banks) — not the tiny 10-name lists.\n" +
    "Passwords from generate_identity / generate_password are STRONG (16 chars, upper+lower+digit+symbol) " +
    "so sites that require symbols accept them — do not invent short/simple passwords yourself.\n" +
    "NOTE: generate_email is FAKE (not a real inbox). For real receive/OTP mail use tool cf_mail " +
    "(create + wait poll) — same CF Worker as Runtime companion.\n\n" +
    "OTP pause (blocks UI like ask_user):\n" +
    "- action=wait (default) — clean code input; human pastes; agent continues.\n" +
    "Fields: kind=email|sms|app|otp, destination, site/service, digits, message.\n" +
    "Prefer cf_mail wait for email codes when a CF mailbox was used; ask_otp wait for SMS/app or unreadable mail.\n" +
    "Do NOT invent OTP codes. Do NOT ask for OTP before the site actually sent one. One pause per real code.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "wait",
          "otp",
          "generate_identity",
          "generate_email",
          "generate_phone",
          "generate_name",
          "generate_dob",
          "generate_address",
          "generate_password",
        ],
        description:
          "wait/otp = pause for human code. generate_* = random fields for form fill (no pause). " +
          "Default wait. Prefer generate_identity once at start of signup, then fill everything. " +
          "generate_password = strong 16-char password (upper+lower+digit+symbol).",
      },
      kind: {
        type: "string",
        description: "email | sms | phone | app | totp | otp — shapes the UI prompt.",
      },
      message: {
        type: "string",
        description: "Optional custom prompt. If empty, a polished default is built.",
      },
      destination: {
        type: "string",
        description: "Where the code was sent (email address or phone), shown to the human.",
      },
      email: { type: "string", description: "Alias of destination for email OTP." },
      phone: { type: "string", description: "Alias of destination for SMS OTP." },
      site: {
        type: "string",
        description: "Service / site name (e.g. Grok, x.ai) shown in the card.",
      },
      service: { type: "string", description: "Alias of site." },
      context: { type: "string", description: "Extra one-line context for the human." },
      hint: { type: "string", description: "Short hint (e.g. «6 digits, expires in 10 min»)." },
      digits: {
        type: "number",
        description: "Expected code length (UI placeholder). Optional.",
      },
      country: {
        type: "string",
        description: "For generate_*: us, uk, de, fr, es, ru, br, in, …",
      },
      locale: { type: "string", description: "Alias of country." },
      email_domain: {
        type: "string",
        description: "Optional domain for generate_email (default random common provider).",
      },
      timeout_sec: {
        type: "number",
        description: "Optional wait timeout seconds (0 = wait forever until human answers).",
      },
    },
    required: [],
  },

  // exported for unit tests
  generateIdentity,
  generateEmail,
  generatePhone,
  generateName,
  generateDob,
  generateAddress,
  generateGender,
  generatePassword,
  passwordLooksStrong,
  normalizeCountry,
  buildPrompt,

  async execute(input = {}, context = {}) {
    const action = String(input.action || "wait")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

    // ── generators (no pause) ─────────────────────────────────────────
    if (action === "generate_identity" || action === "identity") {
      return { action: "generate_identity", identity: generateIdentity(input) };
    }
    if (action === "generate_email" || action === "email") {
      const id = generateEmail(input);
      return { action: "generate_email", ...id };
    }
    if (action === "generate_phone" || action === "phone") {
      const p = generatePhone(input.country || input.locale);
      return { action: "generate_phone", ...p };
    }
    if (action === "generate_name" || action === "name") {
      const n = generateName(input.country || input.locale);
      return { action: "generate_name", ...n };
    }
    if (action === "generate_dob" || action === "dob" || action === "birth_date" || action === "birthday") {
      return { action: "generate_dob", ...generateDob(input) };
    }
    if (action === "generate_address" || action === "address") {
      return { action: "generate_address", ...generateAddress(input.country || input.locale) };
    }
    if (action === "generate_password" || action === "password") {
      const password = generatePassword({ length: input.length || input.len || 16 });
      return {
        action: "generate_password",
        password,
        length: password.length,
        strong: passwordLooksStrong(password),
        note: "Use this password as-is (upper+lower+digit+symbol). Keep same for the whole account.",
      };
    }

    // ── wait for OTP (pause like ask_user) ────────────────────────────
    const kind = String(input.kind || "otp").toLowerCase();
    const destination =
      String(input.destination || input.email || input.phone || "").trim() || "";
    const site = String(input.site || input.service || "").trim();
    const digitsExpected = Math.max(0, Math.min(12, Number(input.digits) || 0));
    const question =
      String(input.message || "").trim() ||
      buildPrompt(kind, {
        destination,
        site,
        context: input.context,
        hint: input.hint || (digitsExpected ? `${digitsExpected} digits` : ""),
      });

    if (!context.askUser || typeof context.askUser !== "function") {
      throw new Error("ask_otp is not available in this session (no UI bridge)");
    }

    const timeoutSec = Math.max(0, Number(input.timeout_sec || input.timeoutSec) || 0);
    // Bridge currently waits forever unless we wrap; pass timeout via extended handler if present
    const answer = await context.askUser({
      toolCallId: context.toolCallId,
      question,
      options: [],
      multiSelect: false,
      allowFreeText: true,
      // UI hints (ignored by bridge, used by renderer from tool input)
      mode: "otp",
      kind,
      destination,
      site,
      digits: digitsExpected,
      timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : 0,
    });

    const raw = String(answer?.answer || (answer?.selected && answer.selected[0]) || "").trim();
    // Normalize: prefer pure 4–12 digit OTP even if wrapped in "code: 123456" / labels
    const digitsOnly = raw.replace(/[^\d]/g, "");
    const compact = raw.replace(/\s+/g, "");
    let code = compact;
    if (digitsOnly.length >= 4 && digitsOnly.length <= 12) {
      // "123 456", "code: 998877", "OTP-112233" → digits only when clearly a short code
      const nonDigitLetters = raw.replace(/[\d\s:.\-_/()#*]+/gi, "");
      if (nonDigitLetters.length <= 8) code = digitsOnly;
    } else if (/^\d{4,12}$/.test(compact)) {
      code = compact;
    }

    if (!code) {
      return {
        action: "wait",
        ok: false,
        kind,
        destination,
        site,
        question,
        code: "",
        error: "Human submitted an empty code. Call ask_otp again if still needed.",
      };
    }

    return {
      action: "wait",
      ok: true,
      kind,
      destination,
      site,
      question,
      code,
      raw,
      digits: code.replace(/\D/g, "").length,
      note: "Use this code immediately in the open form/page, then continue the flow.",
    };
  },
};
