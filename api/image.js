// api/image.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt } = req.body;
    const apiKey = process.env.HUGGINGFACE_API_KEY;

    // モデルはお好みで変えられます（例: stabilityai/stable-diffusion-xl-base-1.0）
    const model = "stabilityai/stable-diffusion-xl-base-1.0";

    try {
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

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Hugging Face API Error: ${error}`);
        }

        // 画像データ(Blob)を取得してBase64に変換
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

        return res.status(200).json({ image: base64Image });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: '画像生成に失敗しました（モデルがロード中の可能性があります）' });
    }
}
