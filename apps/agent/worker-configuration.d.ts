declare namespace Cloudflare {
  interface Env {
    Agent:          DurableObjectNamespace<import("./src/agent").Agent>;
    App:          DurableObjectNamespace<import("./src/app").App>;
    Room:         DurableObjectNamespace<import("./src/room").Room>;
    Sandbox:        DurableObjectNamespace<import("./src/sandbox").Sandbox>;
    WarmPool:       DurableObjectNamespace<import("./src/warm-pool").WarmPool>;
    AI:             Ai;
    SKILLS:         R2Bucket;
    ASSETS:         R2Bucket;
    ARTIFACTS?:     Artifacts;
    LOADER:         WorkerLoader;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?:   string;
    BRAVE_API_KEY?:  string;
    WARM_POOL_TARGET?:           string;
    ACCESS_TEAM_DOMAIN?:         string;  // e.g. "yourteam.cloudflareaccess.com"
    ACCESS_AUD?:                 string;  // Application AUD tag from Access settings
    WARM_POOL_REFRESH_INTERVAL?: string;
    ACCESS_DEV_USER?:            string;  // JSON identity for local dev
    GCHAT_WEBHOOK_URL?:          string;  // Google Chat incoming webhook for mention notifications
    APP_BASE_URL?:               string;  // Public origin used to build absolute URLs
    // R2 S3 credentials for the `assets publish` shell command.
    // Optional; when any is unset the Agent skips wiring the assets
    // client and the shell command reports "not configured" rather
    // than failing on the presign step. The wrangler.jsonc `vars`
    // block declares them as empty strings so the names are visible
    // to wrangler dev; secrets override the vars in deploy.
    R2_ACCESS_KEY_ID?:           string;
    R2_SECRET_ACCESS_KEY?:       string;
    CLOUDFLARE_ACCOUNT_ID?:      string;
    R2_ENDPOINT?:                string;  // optional override of the account-derived endpoint
  }
}
interface Env extends Cloudflare.Env {}
