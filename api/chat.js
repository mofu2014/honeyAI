export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { prompt } = req.body;

  // 1. 17個のキーからランダムに1つ選ぶ
  const keyIndex = Math.floor(Math.random() * 17) + 1; // 1〜17
  const apiKey = process.env[`GEMINI_KEY_${keyIndex}`];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt + "。出力はHTMLコードのみ、markdownの枠(```html)は不要。" }] }]
      })
    });

    const data = await response.json();
    const htmlOutput = data.candidates[0].content.parts[0].text;

    res.status(200).json({ html: htmlOutput });
  } catch (error) {
    res.status(500).json({ error: "エラー発生。キーを回していますが制限に達した可能性があります。" });
  }
}
