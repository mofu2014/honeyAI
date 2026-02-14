// api/image.js
module.exports = async function handler(req, res) {
    // POSTメソッド以外は拒否
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;
    const apiKey = process.env.HUGGINGFACE_API_KEY;

    // APIキーがない場合のチェック
    if (!apiKey) {
        return res.status(500).json({ error: 'HUGGINGFACE_API_KEYが設定されていません。Vercelの環境変数を確認してください。' });
    }

    // モデル（少し軽量で安定しているモデルに変更しました）
    // もしリアルなのが良ければ "stabilityai/stable-diffusion-xl-base-1.0" に戻してください
    const model = "runwayml/stable-diffusion-v1-5";

    try {
        console.log(`Generating image for: ${prompt} with model: ${model}`);

        const response = await fetch(
            `https://api-inference.huggingface.co/models/${model}`,
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                method: "POST",
                body: JSON.stringify({ inputs: prompt }),
            }
        );

        // エラーハンドリング
        if (!response.ok) {
            const errorText = await response.text();
            console.error("Hugging Face API Error:", errorText);
            
            // モデルが起動中（ロード中）の場合によくあるエラー
            if (errorText.includes("loading")) {
                return res.status(503).json({ error: 'モデルを起動中です...。20秒ほど待ってからもう一度試してみてね！' });
            }
            throw new Error(`API Error: ${response.status} ${errorText}`);
        }

        // 画像データを取得
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error("Server Error:", error);
        return res.status(500).json({ error: `画像生成に失敗したみつ...: ${error.message}` });
    }
};
