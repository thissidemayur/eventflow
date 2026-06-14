import {Counter,Gauge,Registry, collectDefaultMetrics} from "prom-client"

// each process(API,worker) get its own registry
// exposed sepereate /metrics endpoint
// promotheous scrapes both

export const registry = new Registry()
// collect node.js default metrics: memory ,cpu, event loop lag
collectDefaultMetrics({register:registry,prefix:"eventflow_"})

const counterDefinitions: Record<string, string> = {
  // admin auth
  admin_auth_failed: "total Failed Admin Auth",
  admin_tenant_created: "Total tenant created",

  // api key
  auth_success_total: "Total successful API key authentications",
  auth_missing_key_total: "Total requests with missing API key",
  auth_invalid_key_total: "Total requests with invalid API key",
  auth_error_total: "Total auth DB lookup errors",
  auth_cache_hit_total: "Total API key auth served from cache",
  auth_cache_miss_total: "Total API key auth requiring DB lookup",

  // Rate limiting — IP
  ratelimit_ip_allowed_total: "Total requests allowed by IP rate limiter",
  ratelimit_ip_rejected_total: "Total requests rejected by IP rate limiter",
  ratelimit_ip_error_total: "Total IP rate limiter Redis errors",

  // Rate limiting — API key
  ratelimit_apikey_allowed_total:
    "Total requests allowed by API key rate limiter",
  ratelimit_apikey_rejected_total:
    "Total requests rejected by API key rate limiter",
  ratelimit_apikey_error_total: "Total API key rate limiter Redis errors",

  // Events
  events_accepted_total: "Total events accepted and enqueued",
  events_duplicate_total: "Total idempotent duplicate requests",
  events_enqueue_error_total: "Total failures to enqueue events",
  events_list_cache_hit_total: "Total events list responses served from cache",
  events_list_cache_miss_total:
    "Total events list cache misses requiring DB query",
  // Jobs (worker)
  jobs_started_total: "Total jobs picked up by worker",
  jobs_completed_total: "Total jobs completed successfully",
  jobs_failed_total: "Total jobs failed after retries",

  // Notifications
  notifications_discord_sent_total: "Total Discord notifications sent",
  notifications_discord_failed_total: "Total Discord notification failures",
  notifications_email_sent_total: "Total email notifications sent",
  notifications_email_failed_total: "Total email notification failures",
  notifications_skipped_total: "Total notifications skipped (idempotent)",

  // DLQ
  dlq_jobs_added_total: "Total jobs moved to DLQ",
  dlq_jobs_failed_to_add_total: "Total failures to add jobs to DLQ",
  dlq_job_replayed_total: "Total jobs replayed from DLQ",
  dlq_batch_completed_total: "Total DLQ replay batches completed",
  dlq_replay_completed_total: "Total DLQ replay operations completed",

  // Infrastructure
  postgres_down_total: "Total times postgres health check failed",
  redis_down_total: "Total times redis health check failed",
};

const counters = new Map<string,Counter>();
for (const[name,help] of Object.entries(counterDefinitions)) {
    counters.set(name,new Counter({name:`eventflow_${name}`,help,registers:[registry]}))
}


const gauges = new Map<string,Gauge>();
function ensureGauge(name:string,help:string):Gauge{
    if(!gauges.has(name)){
        gauges.set(name,new Gauge({
            name: `eventflow_${name}`,
            help,
            registers:[registry]
        }))
    }
    return gauges.get(name)!;
}

const httpRequestController = new Counter({
    name: "eventflow_http_requests_total",
    help:"Total HTTP requests by method,path and status",
    labelNames:["method","path","status"],
    registers:[registry]
})


function toPromethusName(dotName:string):string{
    return dotName.replace(/\./g,"_").replace(/-/g,"_");
}


export class Metrics {
    increment(name:string,amount=1) {
        const promName = toPromethusName(name)
        const counter = counters.get(promName) ?? counters.get(`${promName}_total`)
        if(counter){
            counter.inc(amount)
        }

    }

    gauge(name:string,value:number){
        const promName = toPromethusName(name)
        const help = `Gauage for ${name}`;
        const g = ensureGauge(promName,help)
        g.set(value)
    }

    async snapshot():Promise<Record<string,unknown>>{
       const metrics = await registry.getMetricsAsJSON()
        return {
            metrics,
            timestamp: new Date().toISOString()
        }
    }

    // New: Prometheous text format for scrapping
    async prometheusFormat(): Promise<string>{
        return registry.metrics()
    }

    trackRequest(method:string,path:string,status:number):void {
        httpRequestController.labels(method, path, String(status)).inc();
    
    }
}

// singleton- shared across the process
export const metrics = new Metrics()