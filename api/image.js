export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  let body = "";
  await new Promise((resolve, reject) => {
    req.on("data", chunk => body += chunk);
    req.on("end", resolve);
    req.on("error", reject);
  });

  const { prompt } = JSON.parse(body);

  const response = await fetch(
    "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-2",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.HF_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ inputs: prompt })
    }
  );

  const contentType = response.headers.get("content-type");

  if (!contentType || !contentType.includes("image")) {
    const errorText = await response.text();
    return res.status(500).json({ error: errorText });
  }

  const buffer = await response.arrayBuffer();
  res.setHeader("Content-Type", "image/png");
  res.status(200).send(Buffer.from(buffer));
}
