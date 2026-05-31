const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const desktopDir = '/Users/rajeevtiwari/Desktop';
const outputFilePath = '/Users/rajeevtiwari/Desktop/AI-powered Store Intelligence System/extracted_images/desktop_text.txt';

fs.writeFileSync(outputFilePath, '');

async function runOCR() {
  const files = fs.readdirSync(desktopDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
    .sort();

  console.log(`Found ${files.length} images on Desktop to process.`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const imagePath = path.join(desktopDir, file);
    console.log(`Processing Desktop image ${i + 1}/${files.length}: ${file}...`);
    try {
      const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
      const header = `\n=========================================\nIMAGE ${i + 1} (${file})\n=========================================\n`;
      fs.appendFileSync(outputFilePath, header + text + '\n');
      console.log(`Finished ${file}`);
    } catch (err) {
      console.error(`Error on ${file}:`, err);
    }
  }

  console.log(`OCR complete! Output saved to: ${outputFilePath}`);
}

runOCR();
