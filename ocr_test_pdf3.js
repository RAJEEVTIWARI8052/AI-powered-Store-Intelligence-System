const Tesseract = require('tesseract.js');

async function test() {
  const { data: { text } } = await Tesseract.recognize('/Users/rajeevtiwari/.gemini/antigravity/scratch/pdf3_p1_Im1.jpg.png', 'eng');
  console.log("OCR Result:\n", text);
}
test();
