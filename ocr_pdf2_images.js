const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const imgDir = '/Users/rajeevtiwari/Desktop/AI-powered Store Intelligence System/extracted_images/pdf2';
const outputFilePath = '/Users/rajeevtiwari/Desktop/AI-powered Store Intelligence System/extracted_images/pdf2_text.txt';

fs.writeFileSync(outputFilePath, '');

async function runOCR() {
  const files = fs.readdirSync(imgDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
    .sort((a, b) => {
      const pageA = parseInt(a.match(/page_(\d+)_/)[1], 10);
      const pageB = parseInt(b.match(/page_(\d+)_/)[1], 10);
      return pageA - pageB;
    });

  console.log(`Found ${files.length} images to process.`);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const imagePath = path.join(imgDir, file);
    console.log(`Processing page ${i + 1}/${files.length}: ${file}...`);
    try {
      const { data: { text } } = await Tesseract.recognize(imagePath, 'eng');
      const header = `\n=========================================\nPAGE ${i + 1} (${file})\n=========================================\n`;
      fs.appendFileSync(outputFilePath, header + text + '\n');
      console.log(`Finished page ${i + 1}`);
    } catch (err) {
      console.error(`Error on page ${i + 1} (${file}):`, err);
    }
  }

  console.log(`OCR complete! Output saved to: ${outputFilePath}`);
}

runOCR();
