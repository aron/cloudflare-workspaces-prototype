declare namespace Cloudflare {
  interface Env {
    Agent:          DurableObjectNamespace<import("./src/agent").Agent>;
    App:          DurableObjectNamespace<import("./src/app").App>;
    Room:         DurableObjectNamespace<import("./src/room").Room>;
    Sandbox:        DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
    WarmPool:       DurableObjectNamespace<import("./src/warm-pool").WarmPool>;
    AI:             Ai;
    LOADER:         WorkerLoader;
    SKILLS:         R2Bucket;
    Artifacts:      import("@cloudflare/workspace/git").ArtifactsBinding;
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
  }
}
interface Env extends Cloudflare.Env {}
