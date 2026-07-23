const express = require("express");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================
// CONFIGURAZIONE PER OGNI CLIENTE SNACK
// ============================================
const SNACKS = {
  "ahmed_snack": {
    name: "Ahmed Snack",
    owner: "Ahmed",
    whatsapp: process.env.AHMED_WHATSAPP || "+33600000000",
    language: "fr-FR",
    voice: "Polly.Lea",
    menu: `
      - Tacos simple: 5€
      - Tacos double: 7€
      - Tacos triple: 9€
      - Burger maison: 6€
      - Frites: 2€
      - Boisson: 1.50€
      - Menu tacos + frites + boisson: 8€
    `,
    greeting: "Bonjour! C'est Ahmed, je suis en cuisine en ce moment. Dites-moi ce que vous voulez commander!",
    hours: "Lundi-Samedi 11h-22h, Dimanche 12h-21h",
  },
  "hassan_snack": {
    name: "Hassan Snack",
    owner: "Hassan",
    whatsapp: process.env.HASSAN_WHATSAPP || "+39300000000",
    language: "it-IT",
    voice: "Polly.Giorgio",
    menu: `
      - Kebab: 5€
      - Kebab maxi: 7€
      - Pizza: 4€
      - Patatine: 2€
      - Bibita: 1.50€
      - Menu kebab + patatine + bibita: 8€
    `,
    greeting: "Ciao! Sono Hassan, sono in cucina. Dimmi pure cosa vuoi ordinare!",
    hours: "Lunedi-Sabato 11-22, Domenica 12-21",
  }
};

// Memoria conversazioni attive
const conversations = {};

// ============================================
// WEBHOOK — RISPOSTA INIZIALE
// ============================================
app.post("/voice/:snack_id", (req, res) => {
  const snackId = req.params.snack_id;
  const snack = SNACKS[snackId];
  const callSid = req.body.CallSid;

  if (!snack) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Service non disponible.");
    return res.type("text/xml").send(twiml.toString());
  }

  // Inizializza conversazione
  conversations[callSid] = {
    snackId,
    messages: [],
    startTime: Date.now(),
  };

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ language: snack.language, voice: snack.voice }, snack.greeting);

  const gather = twiml.gather({
    input: "speech",
    action: `/voice/${snackId}/respond`,
    method: "POST",
    language: snack.language,
    speechTimeout: "auto",
    timeout: 6,
  });
  gather.say({ language: snack.language, voice: snack.voice }, "...");

  res.type("text/xml").send(twiml.toString());
});

// ============================================
// WEBHOOK — GESTIONE CONVERSAZIONE AI
// ============================================
app.post("/voice/:snack_id/respond", async (req, res) => {
  const snackId = req.params.snack_id;
  const snack = SNACKS[snackId];
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || "";
  const conv = conversations[callSid];

  const twiml = new twilio.twiml.VoiceResponse();

  if (!speechResult) {
    twiml.say({ language: snack.language, voice: snack.voice }, 
      snack.language === "fr-FR" ? "Je n'ai pas compris, pouvez-vous répéter?" : "Non ho capito, puoi ripetere?");
    const gather = twiml.gather({
      input: "speech",
      action: `/voice/${snackId}/respond`,
      method: "POST",
      language: snack.language,
      speechTimeout: "auto",
    });
    return res.type("text/xml").send(twiml.toString());
  }

  conv.messages.push({ role: "user", content: speechResult });

  try {
    const isFr = snack.language === "fr-FR";
    
    const systemPrompt = `Tu es ${snack.owner}, propriétaire de "${snack.name}".
Tu réponds naturellement au téléphone pour prendre les commandes.
Ne mentionne JAMAIS que tu es une IA ou un robot.
Réponds en ${isFr ? "français" : "italien"} uniquement.
Sois chaleureux, rapide et naturel comme un vrai commerçant.

MENU:
${snack.menu}

HORAIRES: ${snack.hours}

INSTRUCTIONS:
- Prends la commande complète
- Demande le prénom du client
- Demande si c'est pour retirer sur place ou livraison
- Quand tu as TOUT (articles + prénom + type), écris exactement à la fin:
[ORDER: nom=PRENOM, commande=ARTICLES, type=RETRAIT/LIVRAISON]

Maximum 2 phrases par réponse. Sois naturel et direct.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system: systemPrompt,
      messages: conv.messages,
    });

    const aiText = response.content[0].text;
    conv.messages.push({ role: "assistant", content: aiText });

    // Controlla se ordine è completo
    const orderMatch = aiText.match(/\[ORDER: (.+?)\]/);
    const cleanText = aiText.replace(/\[ORDER:.+?\]/, "").trim();

    twiml.say({ language: snack.language, voice: snack.voice }, cleanText);

    if (orderMatch) {
      // Invia WhatsApp e chiudi
      await sendWhatsAppOrder(snack, orderMatch[1], req.body.From);
      
      const goodbye = isFr 
        ? "Parfait! Commande bien notée. À tout de suite!"
        : "Perfetto! Ordine registrato. A presto!";
      twiml.say({ language: snack.language, voice: snack.voice }, goodbye);
      twiml.hangup();
      
      // Pulisci memoria
      delete conversations[callSid];
    } else {
      const gather = twiml.gather({
        input: "speech",
        action: `/voice/${snackId}/respond`,
        method: "POST",
        language: snack.language,
        speechTimeout: "auto",
        timeout: 6,
      });
      gather.say({ language: snack.language, voice: snack.voice }, "");
    }

    res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("AI Error:", err);
    const errMsg = snack.language === "fr-FR"
      ? "Désolé, un problème technique. Rappelez dans 2 minutes."
      : "Scusa, problema tecnico. Richiama tra 2 minuti.";
    twiml.say({ language: snack.language, voice: snack.voice }, errMsg);
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  }
});

// ============================================
// INVIA NOTIFICA WHATSAPP
// ============================================
async function sendWhatsAppOrder(snack, orderInfo, customerPhone) {
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    
    const message = 
      `🛎️ *NOUVELLE COMMANDE — ${snack.name}*\n\n` +
      `📋 ${orderInfo}\n` +
      `📞 ${customerPhone || "Numéro masqué"}\n` +
      `⏰ ${time}\n\n` +
      `_VoiceOrder AI_`;

    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${snack.whatsapp}`,
      body: message,
    });

    console.log(`✅ WhatsApp envoyé à ${snack.owner} — ${orderInfo}`);
  } catch (err) {
    console.error("❌ WhatsApp Error:", err.message);
  }
}

// ============================================
// ENDPOINTS UTILI
// ============================================

// Lista snacks attivi
app.get("/snacks", (req, res) => {
  const list = Object.entries(SNACKS).map(([id, s]) => ({
    id, name: s.name, owner: s.owner, language: s.language
  }));
  res.json(list);
});

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "✅ VoiceOrder running",
    version: "1.0.0",
    activeSnacks: Object.keys(SNACKS).length,
    activeCalls: Object.keys(conversations).length,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🎙️ VoiceOrder server on port ${PORT}`));
