// Lazy env accessor — values are read at call time so tests and
// tsx-launched workers can set process.env first. Secrets live in .env only.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseAnonKey() {
    return required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get supabaseDbUrl() {
    return process.env.SUPABASE_DB_URL ?? "";
  },
  get allowedEmail() {
    return required("ALLOWED_EMAIL").toLowerCase();
  },
  get appBaseUrl() {
    return process.env.APP_BASE_URL ?? "http://localhost:3100";
  },
  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get commandModel() {
    return process.env.COMMAND_MODEL ?? "claude-sonnet-5";
  },
  get classifyModel() {
    return process.env.CLASSIFY_MODEL ?? "claude-haiku-4-5";
  },
  get dailyCostCapUsd() {
    return Number(process.env.DAILY_COST_CAP_USD ?? "60");
  },
  // The brain's editable files (PERSONALITY.md / KNOWLEDGE.md / SELF.md).
  get brainDir() {
    return process.env.BRAIN_DIR ?? "./brain";
  },
  // Embeddings for semantic memory recall (uses OPENAI_API_KEY).
  get embeddingModel() {
    return process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
  },
  get heartbeatHmacSecret() {
    return required("HEARTBEAT_HMAC_SECRET");
  },
  get agentApiToken() {
    return required("AGENT_API_TOKEN");
  },
  get heartbeatMdPath() {
    return process.env.HEARTBEAT_MD_PATH ?? "./HEARTBEAT.md";
  },
  get memoryMdPath() {
    return process.env.MEMORY_MD_PATH ?? "./MEMORY.md";
  },
  get telegramBotToken() {
    return required("TELEGRAM_BOT_TOKEN");
  },
  get telegramChatId() {
    return required("TELEGRAM_CHAT_ID");
  },
  get telegramWebhookSecret() {
    return required("TELEGRAM_WEBHOOK_SECRET");
  },
  get openaiApiKey() {
    return process.env.OPENAI_API_KEY ?? "";
  },
  // Text-to-speech (the HUD "Jarvis" voice). Uses the OpenAI key above.
  get ttsModel() {
    return process.env.TTS_MODEL ?? "gpt-4o-mini-tts";
  },
  get ttsVoice() {
    return process.env.TTS_VOICE ?? "onyx";
  },
  get ttsInstructions() {
    return (
      process.env.TTS_INSTRUCTIONS ??
      "Deep, authoritative AI butler in the spirit of JARVIS. Composed, deliberate, and articulate with quiet gravitas. Unhurried cadence, subtly warm, dry understatement. Never robotic, never sing-song."
    );
  },
  get ghlApiKey() {
    return process.env.GHL_API_KEY ?? "";
  },
  get ghlLocationId() {
    return process.env.GHL_LOCATION_ID ?? "";
  },
  get ghlBaseUrl() {
    return process.env.GHL_BASE_URL || "https://services.leadconnectorhq.com";
  },
  get gscClientEmail() {
    return process.env.GSC_CLIENT_EMAIL ?? "";
  },
  get gscPrivateKey() {
    return (process.env.GSC_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  },
  get gscTracked() {
    return process.env.GSC_TRACKED ?? "";
  },
  get hermesUrl() {
    return process.env.HERMES_URL ?? "";
  },
  get hermesApiKey() {
    return process.env.HERMES_API_KEY ?? "";
  },
  get hermesModel() {
    return process.env.HERMES_MODEL ?? "hermes-agent";
  },
  get obsidianVaultPath() {
    return process.env.OBSIDIAN_VAULT_PATH ?? "";
  },
  get obsidianDailyNotesDir() {
    return process.env.OBSIDIAN_DAILY_NOTES_DIR ?? "Daily Notes";
  },
  get obsidianTasksDir() {
    return process.env.OBSIDIAN_TASKS_DIR ?? "Tasks";
  },
  get obsidianBoardNote() {
    return process.env.OBSIDIAN_BOARD_NOTE ?? "Active Command Board.md";
  },
  get obsidianCloseoutDir() {
    return process.env.OBSIDIAN_CLOSEOUT_DIR ?? "Closeouts";
  },
  get backupDir() {
    return process.env.BACKUP_DIR ?? "./backups";
  },
  get offsiteRcloneRemote() {
    return process.env.OFFSITE_RCLONE_REMOTE ?? "";
  },
  get timezone() {
    return process.env.TZ ?? "America/Los_Angeles";
  },
};
