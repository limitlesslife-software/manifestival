// This runs on Vercel's server, not in the browser — so your ANTHROPIC_API_KEY
// environment variable stays private and is never sent to the phone.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { transcript, today, weekday } = req.body || {};
  if (!transcript) {
    res.status(400).json({ error: 'Missing transcript' });
    return;
  }

  const prompt = `Tämän hetken päivämäärä on ${today} (${weekday}).

Käyttäjä sanoi ääneen tämän suomenkielisen komennon elämänhallintasovellukseen: ${JSON.stringify(transcript)}

Tulkitse tämä tehtäväksi tai kalenterimerkinnäksi. Vastaa VAIN JSON-objektilla, ei muuta tekstiä eikä koodilohkomerkintöjä:
{"title":"lyhyt selkeä nimi, max n. 6 sanaa","date":"YYYY-MM-DD paras arvaus, tämä päivä jos ei mainintaa","time":"HH:MM 24h muodossa tai null","category":"yksi: tyo, perhe, hyvinvointi, harrastus, koti, kehitys, talous, muu","note":"lyhyt lisähuomio tai null"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data.error || 'Anthropic API error' });
      return;
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
