#!/usr/bin/env node
/**
 * update-catalog.js
 *
 * A placer AU MEME NIVEAU que catalog.json et le dossier images/.
 * Usage : node update-catalog.js
 *
 * Ce script :
 *  - parcourt images/<categorie>/<dossier>/
 *  - reconstruit "categories" et "folders" de catalog.json
 *  - lit les info.json (titre/artiste) de chaque catégorie et dossier,
 *    de façon tolérante aux petites erreurs de syntaxe (virgules finales...)
 *  - si le "title" d'un info.json est une chaine, le traduit automatiquement
 *    en objet { "en": "...", "fr": "..." } et réécrit l'info.json avec cet
 *    objet (si le title est déjà un objet, il est repris tel quel)
 *  - retire un éventuel suffixe " - <nombre>" en fin de titre (ex: "Set - 3"
 *    → "Set"), que le titre soit une chaine brute ou déjà traduit
 *  - renumérote les images en 01, 02, 03... (sans toucher à celles déjà
 *    correctement numérotées)
 *  - convertit en .jpg les images qui ne sont pas réellement au format JPEG
 *    (nécessite le module "sharp" : npm install sharp)
 *  - génère une miniature "<nom>_thumbnail.jpg" pour chaque image si elle
 *    n'existe pas déjà (nécessite "sharp")
 *  - maintient une catégorie "nouveaute" : tout nouveau sous-dossier détecté
 *    est ajouté au début (max 10 au total, les plus anciens sont éjectés)
 *  - maintient "dailyPuzzles" : 366 entrées (clé "MM-JJ") donnant l'id d'un
 *    puzzle (image) aléatoire pour ce jour. A chaque exécution, seules les
 *    dates "à venir" ou dont la dernière occurrence remonte à 4 mois ou plus
 *    (en date locale) sont régénérées ; les autres restent inchangées.
 *  - conserve featuredFolderIDs tel quel
 *
 * Nécessite Node.js >= 18 (fetch natif) pour la traduction automatique.
 */

const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null;
}

const ROOT_DIR = __dirname;
const CATALOG_PATH = path.join(ROOT_DIR, 'catalog.json');
const IMAGES_DIR = path.join(ROOT_DIR, 'images');
const TARGET_EXT = '.jpg';
const NOUVEAUTE_ID = 'nouveaute';
const NOUVEAUTE_MAX = 10;
const DAILY_LOCK_MONTHS = 4;
const LEAP_YEAR_FOR_CALENDAR = 2024; // année de référence pour générer les 366 jours (inclut 29/02)

// Résolution des miniatures : boîte englobante (ratio conservé), adaptée à
// une galerie iOS défilant horizontalement (style carrousel App Store).
// 640px de long côté correspond à des cellules ~200-215pt en @3x, avec une
// marge confortable pour des cellules plus grandes sur iPad.
const THUMBNAIL_MAX_DIMENSION = 640;
const THUMBNAIL_SUFFIX = '_thumbnail';

// ---------- Utilitaires génériques ----------

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function listDirs(p) {
  return fs
    .readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort(naturalSort);
}

// Tolère les virgules finales (trailing commas), fréquentes dans les
// info.json édités à la main.
function parseLenientJSON(text) {
  const cleaned = text.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned);
}

function readInfoJson(folderPath) {
  const infoPath = path.join(folderPath, 'info.json');
  if (!fs.existsSync(infoPath)) {
    return { data: {}, infoPath, exists: false };
  }
  try {
    const data = parseLenientJSON(fs.readFileSync(infoPath, 'utf8'));
    return { data, infoPath, exists: true };
  } catch (err) {
    console.warn(`⚠️  info.json invalide dans ${folderPath}: ${err.message}`);
    return { data: {}, infoPath, exists: true };
  }
}

function pad(num, width) {
  return String(num).padStart(width, '0');
}

// Retire un suffixe " - <nombre>" en fin de chaine (ex: "Big Cats - 3" -> "Big Cats")
function stripTrailingNumber(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\s*-\s*\d+\s*$/, '').trim();
}

// ---------- Traduction automatique ----------

async function detectAndTranslate(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(
    text
  )}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const translated = data[0].map((chunk) => chunk[0]).join('');
  const detectedLang = data[2];
  return { translated, detectedLang };
}

async function translateToObject(text) {
  try {
    const toEn = await detectAndTranslate(text, 'en');
    const detected = toEn.detectedLang;
    const en = detected === 'en' ? text : toEn.translated;
    let fr;
    if (detected === 'fr') {
      fr = text;
    } else {
      const toFr = await detectAndTranslate(text, 'fr');
      fr = toFr.translated;
    }
    return { en, fr };
  } catch (err) {
    console.warn(`⚠️  Traduction impossible pour "${text}" (${err.message}) — en/fr réglés sur le texte original.`);
    return { en: text, fr: text };
  }
}

// Retourne le title prêt à mettre dans catalog.json (objet {en, fr} ou null
// si aucun title n'est défini dans l'info.json). Si le title était une
// chaine, le traduit et réécrit l'info.json avec l'objet obtenu. Dans tous
// les cas, retire un éventuel suffixe " - <nombre>" en fin de chaque valeur.
async function resolveTitle(infoResult) {
  const { data, infoPath, exists } = infoResult;
  if (!exists || data.title === undefined || data.title === null) {
    return null;
  }

  if (typeof data.title === 'string') {
    const cleaned = stripTrailingNumber(data.title);
    const translated = await translateToObject(cleaned);
    const updated = { ...data, title: translated };
    fs.writeFileSync(infoPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log(`   🌐 Titre traduit : "${data.title}" → { en: "${translated.en}", fr: "${translated.fr}" }`);
    return translated;
  }

  // déjà un objet : on retire juste le suffixe numérique éventuel de chaque langue
  const original = data.title;
  const cleaned = {};
  let changed = false;
  for (const [lang, val] of Object.entries(original)) {
    const strippedVal = stripTrailingNumber(val);
    cleaned[lang] = strippedVal;
    if (strippedVal !== val) changed = true;
  }
  if (changed) {
    const updated = { ...data, title: cleaned };
    fs.writeFileSync(infoPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log('   ✂️  Suffixe numérique retiré du titre existant');
  }
  return cleaned;
}

// ---------- Conversion / renommage des images ----------

function isThumbnailFile(name) {
  return new RegExp(`${THUMBNAIL_SUFFIX}\\.[a-zA-Z0-9]+$`).test(name);
}

async function detectRealExtension(filePath) {
  if (!sharp) return path.extname(filePath).toLowerCase();
  try {
    const metadata = await sharp(filePath).metadata();
    switch (metadata.format) {
      case 'jpeg':
        return '.jpg';
      case 'png':
        return '.png';
      case 'webp':
        return '.webp';
      case 'gif':
        return '.gif';
      case 'tiff':
        return '.tiff';
      default:
        return path.extname(filePath).toLowerCase();
    }
  } catch (err) {
    return path.extname(filePath).toLowerCase();
  }
}

async function ensureJpg(filePath) {
  const realExt = await detectRealExtension(filePath);
  if (realExt === TARGET_EXT || !sharp) {
    return filePath;
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const finalPath = path.join(dir, base + TARGET_EXT);
  // Passe toujours par un fichier temporaire distinct : le chemin final peut
  // être identique au chemin d'entrée (ex: un .jpg qui est en réalité un PNG),
  // et sharp refuse d'écrire dans le fichier qu'il est en train de lire.
  const tempPath = path.join(dir, `__convert_${process.pid}_${Date.now()}${TARGET_EXT}`);

  await sharp(filePath).jpeg({ quality: 90 }).toFile(tempPath);
  fs.unlinkSync(filePath);
  fs.renameSync(tempPath, finalPath);
  console.log(`   🔄 Converti en JPG : ${path.basename(filePath)} → ${path.basename(finalPath)}`);
  return finalPath;
}

async function ensureThumbnail(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, TARGET_EXT);
  const thumbPath = path.join(dir, `${base}${THUMBNAIL_SUFFIX}${TARGET_EXT}`);

  if (fs.existsSync(thumbPath)) return; // déjà générée, on ne touche pas

  if (!sharp) {
    console.warn(`   ⚠️  Miniature non générée pour ${path.basename(filePath)} (module "sharp" manquant).`);
    return;
  }

  await sharp(filePath)
    .resize({
      width: THUMBNAIL_MAX_DIMENSION,
      height: THUMBNAIL_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toFile(thumbPath);
  console.log(`   🖼️  Miniature générée : ${path.basename(thumbPath)}`);
}

// ---------- Traitement d'un dossier (folder) ----------

async function processSubfolder(categoryFolder, subFolderName) {
  const subFolderPath = path.join(IMAGES_DIR, categoryFolder, subFolderName);
  const infoResult = readInfoJson(subFolderPath);
  const info = infoResult.data;

  let files = fs
    .readdirSync(subFolderPath, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((name) => name !== 'info.json' && !name.startsWith('.') && !isThumbnailFile(name))
    .sort(naturalSort);

  // 1) S'assurer que chaque image est un vrai JPEG
  const afterConversion = [];
  for (const name of files) {
    const filePath = path.join(subFolderPath, name);
    const newPath = await ensureJpg(filePath);
    afterConversion.push(path.basename(newPath));
  }
  files = afterConversion.sort(naturalSort);

  // 2) Renuméroter 01, 02, ... dans l'ordre courant
  const total = files.length;
  const width = Math.max(2, String(total).length);
  const targets = files.map((_, idx) => `${pad(idx + 1, width)}${TARGET_EXT}`);

  const tempNames = files.map((name, idx) => `__tmp_${idx}__${name}`);
  files.forEach((name, idx) => {
    if (name !== targets[idx]) {
      fs.renameSync(path.join(subFolderPath, name), path.join(subFolderPath, tempNames[idx]));
    }
  });
  files.forEach((name, idx) => {
    if (name !== targets[idx]) {
      fs.renameSync(path.join(subFolderPath, tempNames[idx]), path.join(subFolderPath, targets[idx]));
      console.log(`   ✏️  Renommé : ${name} → ${targets[idx]}`);
    }
  });

  // 3) Miniatures
  for (const targetName of targets) {
    await ensureThumbnail(path.join(subFolderPath, targetName));
  }

  const folderId = `${categoryFolder}/${subFolderName}`;
  const images = targets.map((name) => ({
    id: `${folderId}/${path.basename(name, TARGET_EXT)}`,
  }));

  const translatedTitle = await resolveTitle(infoResult);

  const folderEntry = {
    id: folderId,
    title: translatedTitle || subFolderName,
    artist: info.artist || 'Freepik',
    images,
  };

  if (info.inAppId !== undefined && info.inAppId !== null && info.inAppId !== '') {
    folderEntry.inAppId = info.inAppId;
  }

  return folderEntry;
}

// ---------- dailyPuzzles ----------
// Toutes les comparaisons de dates se font en arithmétique pure sur
// {année, mois, jour} en HEURE LOCALE (celle de la machine qui lance le
// script), sans jamais passer par un objet Date pour la comparaison — ça
// évite tout décalage UTC/local qui pourrait faire passer "aujourd'hui"
// pour une date future et la régénérer par erreur.

function buildAllDayKeys() {
  const keys = [];
  for (let month = 1; month <= 12; month++) {
    const daysInMonth = new Date(LEAP_YEAR_FOR_CALENDAR, month, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      keys.push(`${pad(month, 2)}-${pad(day, 2)}`);
    }
  }
  return keys; // 366 entrées, dont "02-29"
}

function getTodayLocal() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function dateValue(d) {
  return d.year * 10000 + d.month * 100 + d.day;
}

// Dernière occurrence de ce MM-JJ à la date du jour incluse (cette année si
// déjà passée ou égale à aujourd'hui, sinon l'an dernier).
function lastOccurrenceOnOrBefore(today, month, day) {
  const thisYear = { year: today.year, month, day };
  if (dateValue(thisYear) <= dateValue(today)) {
    return thisYear;
  }
  return { year: today.year - 1, month, day };
}

// Nombre de mois pleins écoulés entre "from" et "to" (from <= to)
function monthsBetween(from, to) {
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (to.day < from.day) months--;
  return months;
}

function pickRandomExcluding(pool, excludeSet) {
  let available = pool.filter((id) => !excludeSet.has(id));
  if (available.length === 0) {
    available = pool; // pool trop petit pour respecter l'exclusion : on autorise un doublon
  }
  return available[Math.floor(Math.random() * available.length)];
}

function generateDailyPuzzles(existing, allPuzzleIds) {
  if (allPuzzleIds.length === 0) {
    console.warn('⚠️  Aucun puzzle dans le catalogue : dailyPuzzles laissé vide.');
    return {};
  }

  const today = getTodayLocal();
  const allKeys = buildAllDayKeys();
  const result = {};
  const eligibleKeys = [];

  for (const key of allKeys) {
    const [mm, dd] = key.split('-').map(Number);
    const hasValidExisting =
      existing && Object.prototype.hasOwnProperty.call(existing, key) && allPuzzleIds.includes(existing[key]);

    if (!hasValidExisting) {
      eligibleKeys.push(key);
      continue;
    }

    const last = lastOccurrenceOnOrBefore(today, mm, dd);
    const age = monthsBetween(last, today);

    if (age >= DAILY_LOCK_MONTHS) {
      eligibleKeys.push(key);
    } else {
      result[key] = existing[key]; // verrouillé : joué récemment (ou aujourd'hui même)
    }
  }

  const reserved = new Set(Object.values(result));
  for (const key of eligibleKeys) {
    const id = pickRandomExcluding(allPuzzleIds, reserved);
    result[key] = id;
    reserved.add(id);
  }

  console.log(`🧩 dailyPuzzles : ${eligibleKeys.length} date(s) régénérée(s), ${366 - eligibleKeys.length} conservée(s).`);

  // Ordonne les clés proprement (MM-JJ croissant)
  const ordered = {};
  for (const key of allKeys) {
    ordered[key] = result[key];
  }
  return ordered;
}

// Si plusieurs folders partagent exactement le même titre (même objet
// {en, fr} ou même chaine), on ajoute " - 1", " - 2", ... à la fin de
// chaque langue pour les distinguer. Recalculé entièrement à chaque
// exécution à partir des titres "propres" (jamais écrit dans les info.json)
// : si un titre redevient unique, le suffixe disparaît tout seul.
function applyDuplicateTitleSuffixes(folders) {
  const keyOf = (title) => (typeof title === 'string' ? `s:${title}` : `o:${title.en}||${title.fr}`);
  const groups = new Map();

  for (const folder of folders) {
    const key = keyOf(folder.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(folder);
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    group.forEach((folder, idx) => {
      const suffix = ` - ${idx + 1}`;
      if (typeof folder.title === 'string') {
        folder.title = folder.title + suffix;
      } else {
        folder.title = { ...folder.title, en: folder.title.en + suffix, fr: folder.title.fr + suffix };
      }
    });
    console.log(`   🔢 ${group.length} dossiers avec le même titre → numérotés (1 à ${group.length})`);
  }
}

// ---------- Main ----------

async function main() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.error(`❌ catalog.json introuvable dans ${ROOT_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(IMAGES_DIR)) {
    console.error(`❌ Dossier "images" introuvable dans ${ROOT_DIR}`);
    process.exit(1);
  }
  if (!sharp) {
    console.warn('⚠️  Le module "sharp" n\'est pas installé : conversion/miniatures seront ignorées.');
    console.warn('   Installe-le avec : npm install sharp');
  }

  const existingCatalog = parseLenientJSON(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const oldFolderIds = new Set((existingCatalog.folders || []).map((f) => f.id));
  const existingNouveauteCategory = (existingCatalog.categories || []).find((c) => c.id === NOUVEAUTE_ID);
  const previousNouveauteIds = existingNouveauteCategory ? existingNouveauteCategory.folderIDs || [] : [];

  const categoryFolders = listDirs(IMAGES_DIR);
  const categories = [];
  const folders = [];
  const newlyDiscoveredIds = [];

  for (const categoryFolder of categoryFolders) {
    if (categoryFolder === NOUVEAUTE_ID) continue; // catégorie gérée séparément

    const categoryPath = path.join(IMAGES_DIR, categoryFolder);
    const categoryInfoResult = readInfoJson(categoryPath);
    const existingCategory = (existingCatalog.categories || []).find((c) => c.id === categoryFolder);

    console.log(`📁 Catégorie : ${categoryFolder}`);

    const translatedCategoryTitle = await resolveTitle(categoryInfoResult);

    const subFolders = listDirs(categoryPath);
    const folderIDs = [];

    for (const subFolderName of subFolders) {
      const folderEntry = await processSubfolder(categoryFolder, subFolderName);
      folders.push(folderEntry);
      folderIDs.push(folderEntry.id);
      console.log(`   ✅ Dossier : ${folderEntry.id} (${folderEntry.images.length} images)`);

      if (!oldFolderIds.has(folderEntry.id)) {
        newlyDiscoveredIds.push(folderEntry.id);
      }
    }

    categories.push({
      id: categoryFolder,
      title: translatedCategoryTitle || (existingCategory && existingCategory.title) || categoryFolder,
      folderIDs,
    });
  }

  // ---- Désambiguïsation des titres identiques ----
  applyDuplicateTitleSuffixes(folders);

  // ---- Catégorie "nouveaute" ----
  const currentFolderIds = new Set(folders.map((f) => f.id));
  const carriedOverIds = previousNouveauteIds.filter((id) => currentFolderIds.has(id) && !newlyDiscoveredIds.includes(id));
  const nouveauteIds = [...newlyDiscoveredIds, ...carriedOverIds].slice(0, NOUVEAUTE_MAX);

  if (newlyDiscoveredIds.length > 0) {
    console.log(`✨ Nouveaux dossiers détectés : ${newlyDiscoveredIds.join(', ')}`);
  }

  const nouveauteCategory = {
    id: NOUVEAUTE_ID,
    title: { fr: 'Nouveauté', en: 'New' },
    folderIDs: nouveauteIds,
  };

  // Les 5 dossiers les plus récents de "nouveaute" (déjà en tête de liste) sont mis en avant
  const featuredFolderIDs = nouveauteIds.slice(0, 5);

  // ---- dailyPuzzles ----
  const allPuzzleIds = folders.flatMap((f) => f.images.map((img) => img.id));
  const dailyPuzzles = generateDailyPuzzles(existingCatalog.dailyPuzzles, allPuzzleIds);

  const newCatalog = {
    featuredFolderIDs,
    categories: [nouveauteCategory, ...categories],
    folders,
    dailyPuzzles,
  };

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(newCatalog, null, 2) + '\n', 'utf8');
  console.log(
    `\n✅ catalog.json mis à jour (${newCatalog.categories.length} catégories, ${folders.length} dossiers, ${nouveauteIds.length} en "nouveauté").`
  );
}

main().catch((err) => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});