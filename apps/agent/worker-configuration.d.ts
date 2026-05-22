declare namespace Cloudflare {
  interface Env {
    Agent:          DurableObjectNamespace<import("./src/agent").Agent>;
    Sandbox:        DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
    WarmPool:       DurableObjectNamespace<import("./src/warm-pool").WarmPool>;
    AI:             Ai;
    LOADER:         WorkerLoader;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?:   string;
    WARM_POOL_TARGET?:           string;
    ACCESS_TEAM_DOMAIN?:         string;  // e.g. "yourteam.cloudflareaccess.com"
    ACCESS_AUD?:                 string;  // Application AUD tag from Access settings
    WARM_POOL_REFRESH_INTERVAL?: string;
  }
}
interface Env extends Cloudflare.Env {}
