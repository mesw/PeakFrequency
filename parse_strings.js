const fs = require('fs');
const path = require('path');

const resMap = {
  'resources': { code: 'en', name: 'English', native: 'English', flag: '🇬🇧' },
  'resources-deu': { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪' },
  'resources-spa': { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸' },
  'resources-fre': { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷' },
  'resources-ita': { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹' },
  'resources-dut': { code: 'nl', name: 'Dutch', native: 'Nederlands', flag: '🇳🇱' },
  'resources-pol': { code: 'pl', name: 'Polish', native: 'Polski', flag: '🇵🇱' },
  'resources-por': { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹' },
  'resources-swe': { code: 'sv', name: 'Swedish', native: 'Svenska', flag: '🇸🇪' },
  'resources-dan': { code: 'da', name: 'Danish', native: 'Dansk', flag: '🇩🇰' },
  'resources-nob': { code: 'nb', name: 'Norwegian', native: 'Norsk', flag: '🇳🇴' },
  'resources-fin': { code: 'fi', name: 'Finnish', native: 'Suomi', flag: '🇫🇮' },
  'resources-ces': { code: 'cs', name: 'Czech', native: 'Čeština', flag: '🇨🇿' },
  'resources-hun': { code: 'hu', name: 'Hungarian', native: 'Magyar', flag: '🇭🇺' }
};

const allLangs = {};

Object.entries(resMap).forEach(([folder, info]) => {
  const filePath = path.join(__dirname, '..', folder, 'strings', 'strings.xml');
  if (!fs.existsSync(filePath)) {
    console.error('File not found:', filePath);
    return;
  }
  const xml = fs.readFileSync(filePath, 'utf8');
  const strings = {};
  const re = /<string\s+id="([^"]+)">([\s\S]*?)<\/string>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const key = match[1];
    let val = match[2]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\\n/g, '\n')
      .trim();
    strings[key] = val;
  }
  allLangs[info.code] = {
    info,
    strings
  };
});

const outJsPath = path.join(__dirname, 'docs', 'assets', 'translations.js');
const jsContent = '/* Auto-generated from Garmin Connect IQ resources-* XML strings */\n(typeof window !== "undefined" ? window : global).PEAK_I18N = ' + JSON.stringify(allLangs, null, 2) + ';\n';
fs.writeFileSync(outJsPath, jsContent, 'utf8');
console.log('Written to:', outJsPath, 'Size:', fs.statSync(outJsPath).size);
