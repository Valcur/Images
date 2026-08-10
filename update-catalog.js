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
 *  - renumérote les images en 01, 02, 03... (sans toucher à celles déjà
 *    correctement numérotées)
 *  - convertit en .jpg les images qui ne sont pas réellement au format JPEG
 *    (nécessite le module "sharp" : npm install sharp)
 *  - maintient une catégorie "nouveaute" : tout nouveau sous-dossier détecté
 *    est ajouté au début (max 10 au total, les plus anciens sont éjectés)
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
// chaine, le traduit et réécrit l'info.json avec l'objet obtenu.
async function resolveTitle(infoResult) {
  const { data, infoPath, exists } = infoResult;
  if (!exists || data.title === undefined || data.title === null) {
    return null;
  }
  if (typeof data.title === 'string') {
    const translated = await translateToObject(data.title);
    const updated = { ...data, title: translated };
    fs.writeFileSync(infoPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    console.log(`   🌐 Titre traduit : "${data.title}" → { en: "${translated.en}", fr: "${translated.fr}" }`);
    return translated;
  }
  // déjà un objet : on le reprend tel quel
  return data.title;
}

// ---------- Conversion / renommage des images ----------

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
  const jpgPath = filePath.slice(0, -path.extname(filePath).length) + TARGET_EXT;
  await sharp(filePath).jpeg({ quality: 90 }).toFile(jpgPath);
  fs.unlinkSync(filePath);
  console.log(`   🔄 Converti en JPG : ${path.basename(filePath)} → ${path.basename(jpgPath)}`);
  return jpgPath;
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
    .filter((name) => name !== 'info.json' && !name.startsWith('.'))
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

  const folderId = `${categoryFolder}/${subFolderName}`;
  const images = targets.map((name) => ({
    id: `${folderId}/${path.basename(name, TARGET_EXT)}`,
  }));

  const translatedTitle = await resolveTitle(infoResult);

  return {
    id: folderId,
    title: translatedTitle || subFolderName,
    artist: info.artist || 'Freepik',
    images,
  };
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
    console.warn('⚠️  Le module "sharp" n\'est pas installé : la vérification/conversion de format sera ignorée.');
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

  const newCatalog = {
    featuredFolderIDs: existingCatalog.featuredFolderIDs || [],
    categories: [nouveauteCategory, ...categories],
    folders,
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