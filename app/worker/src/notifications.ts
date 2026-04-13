import {Prisma} from "@prisma/client"


interface NotificationPayload {
  eventType: string;
  tenantId: string;
  payload: Prisma.InputJsonValue;
}

export async function sendNotification(data: NotificationPayload) {

    const webhookURL = process.env.DISCORD_WEBHOOK_URL
    if(!webhookURL)return // gracefully no operation in dev

    const response = await fetch(webhookURL,{
        method:"POST",
        headers:{
            "Content-Type":"application/json"
        },
        body: JSON.stringify({
            content:`New Event: **${data.eventType}`,
            embeds:[{
                title: data.eventType,
                fields:[
                    {
                        name:"Tenant", value: data.tenantId, inline:true
                    },
                    {
                        name:"Payload", value: JSON.stringify(data.payload,null,2).slice(0,1000)
                    }
                ]
            }]
        })
    })

    if(!response.ok){
        // throw , so bulllmq knows this job failed and should retry
        throw new Error(`Discord webhook failed: ${response.status}`)
    }



}