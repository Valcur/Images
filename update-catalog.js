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
 *  - lit les info.json (titre/artiste) de chaque catégorie et dossier
 *  - renumérote les images en 01, 02, 03... (sans toucher à celles déjà
 *    correctement numérotées)
 *  - convertit en .jpg les images qui ne sont pas réellement au format JPEG
 *    (nécessite le module "sharp" : npm install sharp)
 *  - conserve featuredFolderIDs tel quel
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

// ---------- Utilitaires ----------

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

function readInfoJson(folderPath) {
  const infoPath = path.join(folderPath, 'info.json');
  if (fs.existsSync(infoPath)) {
    try {
      return JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    } catch (err) {
      console.warn(`⚠️  info.json invalide dans ${folderPath}: ${err.message}`);
      return {};
    }
  }
  return {};
}

// catalog.json fourni en exemple contient des virgules finales (trailing
// commas), ce qui n'est pas du JSON strict. On les tolère à la lecture.
function parseLenientJSON(text) {
  const cleaned = text.replace(/,(\s*[\]}])/g, '$1');
  return JSON.parse(cleaned);
}

function pad(num, width) {
  return String(num).padStart(width, '0');
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
  const jpgPath = filePath.slice(0, -path.extname(filePath).length) + TARGET_EXT;
  await sharp(filePath).jpeg({ quality: 90 }).toFile(jpgPath);
  fs.unlinkSync(filePath);
  console.log(`   🔄 Converti en JPG : ${path.basename(filePath)} → ${path.basename(jpgPath)}`);
  return jpgPath;
}

// ---------- Traitement d'un dossier (folder) ----------

async function processSubfolder(categoryFolder, subFolderName) {
  const subFolderPath = path.join(IMAGES_DIR, categoryFolder, subFolderName);
  const info = readInfoJson(subFolderPath);

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

  // Renommage en 2 passes via des noms temporaires pour éviter les collisions
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

  return {
    id: folderId,
    title: info.title || subFolderName,
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

  const categoryFolders = listDirs(IMAGES_DIR);
  const categories = [];
  const folders = [];

  for (const categoryFolder of categoryFolders) {
    const categoryPath = path.join(IMAGES_DIR, categoryFolder);
    const categoryInfo = readInfoJson(categoryPath);
    const existingCategory = (existingCatalog.categories || []).find((c) => c.id === categoryFolder);

    console.log(`📁 Catégorie : ${categoryFolder}`);

    const subFolders = listDirs(categoryPath);
    const folderIDs = [];

    for (const subFolderName of subFolders) {
      const folderEntry = await processSubfolder(categoryFolder, subFolderName);
      folders.push(folderEntry);
      folderIDs.push(folderEntry.id);
      console.log(`   ✅ Dossier : ${folderEntry.id} (${folderEntry.images.length} images)`);
    }

    categories.push({
      id: categoryFolder,
      title: categoryInfo.title || (existingCategory && existingCategory.title) || categoryFolder,
      folderIDs,
    });
  }

  const newCatalog = {
    featuredFolderIDs: existingCatalog.featuredFolderIDs || [],
    categories,
    folders,
  };

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(newCatalog, null, 2) + '\n', 'utf8');
  console.log(`\n✅ catalog.json mis à jour (${categories.length} catégories, ${folders.length} dossiers).`);
}

main().catch((err) => {
  console.error('❌ Erreur :', err);
  process.exit(1);
});
