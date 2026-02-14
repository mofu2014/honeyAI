// api/image.js
// Pollinations.ai を使った画像生成（APIキー不要・無料・高速）

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;
    
    // 日本語のプロンプトだと精度が落ちることがあるので、URLエンコードする
    // seedをランダムにすることで、毎回違う絵が出るようにする
    const seed = Math.floor(Math.random() * 100000);
    const imageUrl = `https://pollinations.ai/p/${encodeURIComponent(prompt)}?width=1024&height=1024&seed=${seed}&model=flux`;

    try {
        console.log(`Generating image via Pollinations: ${prompt}`);

        // 画像データを取得
        const response = await fetch(imageUrl);

        if (!response.ok) {
            throw new Error(`Pollinations API Error: ${response.status}`);
        }

        // 画像データをバッファとして取得
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        // Base64に変換してフロントエンドに返す
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error("Image Generation Error:", error);
        return res.status(500).json({ error: "画像生成に失敗しました（Pollinations）" });
    }
};
