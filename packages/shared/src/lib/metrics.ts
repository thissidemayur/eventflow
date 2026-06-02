
export class Metrics {
    private counters: Map<string,number> = new Map();
    private gauges: Map<string,number>= new Map()

    increment(name:string,amount=1) {
        this.counters.set(name,(this.counters.get(name) ?? 0)+amount)
    }

    gauge(name:string,value:number){
        this.gauges.set(name,value)
    }

    snapshot(){
        return {
          counters: Object.fromEntries(this.counters),
          gauges: Object.fromEntries(this.gauges),
          timestamp: new Date().toISOString(),
        };
    }
}

// singleton- shared across the process
export const metrics = new Metrics()