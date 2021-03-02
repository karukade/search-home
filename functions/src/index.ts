import * as functions from 'firebase-functions';
import * as admin from "firebase-admin"
import * as line from "@line/bot-sdk"
import fetch from "node-fetch"
import {JSDOM} from "jsdom"


const {uid: UID, token: TOKEN, channel: CHANNEL} = functions.config().secret as {
  uid: string,
  token: string
  channel: string
}
admin.initializeApp()
const db = admin.firestore()

const GOOHOME_DOMAIN = "https://goohome.jp"
const QUERIES = [
  `${GOOHOME_DOMAIN}/chintai/mansion/tomisiro/?area=007-010-012-016&price=-70000&madori=203-301-302-303-401-402-403-501&kodawari=2301-2503-2701-2902&sort=11&page=1-100`,
  `${GOOHOME_DOMAIN}/chintai/mansion/naha/?area=011-025-032-042-059-063&price=-75000&madori=203-301-302-303-401-402-403-501-502-503-601-602&kodawari=2301-2701-2902&sort=11&page=1-100`,
  `${GOOHOME_DOMAIN}/chintai/mansion/haebaru/?area=001&price=-70000&madori=202-203-301-302-303-401-402-403-501-502-503&kodawari=2301&sort=11&page=1-100`,
]

/**
 * line bot webhook
*/
export const storeUser = functions.region("asia-northeast1").https.onRequest( async (req, res) => {
  if (req.method !== "POST" || !validateRequest(req)) {
    res.end()
    return
  }

  const body = req.body as { events: line.WebhookEvent[] }
  const message = body.events[0];

  if (message.source.type === "group") {
    const { source: { groupId } } = message;
    const ref = db.doc(`users/${groupId}`)
    await db.runTransaction(async t => {
      const group = await t.get(ref)
      if (!group.exists) {
        await t.set(ref, { id: groupId })
      }
    })
  }

  res.end()
})

const validateRequest = (req: functions.https.Request) => {
  const signature = req.get("x-line-signature")
  if (!signature) return false
  return line.validateSignature(req.rawBody, CHANNEL, signature)
}

/**
 * 定期的にスクレイピング
 * storeにない物件があれば通知
*/
export const searchHomeV2 = functions.region("asia-northeast1").pubsub.schedule("00 9-20/1 * * *").timeZone("Asia/Tokyo").onRun(async () => {

  const links = (await Promise.all(QUERIES.map(query => getLinks(query)))).flat()

  if (!links.length) {
    return
  }

  const ref = await db.collection("links").withConverter(createConverter<{links: string[]}>()).doc("link")

  try {
    const storedLinks = await db.runTransaction(async t => {
      const res = await t.get(ref)
      if (res.exists) return res.data()?.links
      await t.set(ref, {links})
      return undefined
    })

    if (!storedLinks) return

    const newOne = links.filter((link) => !storedLinks.includes(link))

    if (newOne.length) {
      const users = await getUserIds()
      const message = createMessage(newOne)
      await ref.set({links})
      await Promise.all(users.map(id => sendMessage(message, id)))
    }
  } catch(e) {
    console.log(e)
    await sendMessage(`エラーが発生しました`)
  }
});

const sendMessage = async (text: string, id:string = UID) => {
  const client = new line.Client({
    channelAccessToken: TOKEN,
  });
  const message = {
    type: "text",
    text,
  } as const
  await client.pushMessage(id, message)
}

const createMessage = (links: string[]) => {
  const linkStrings = links.reduce((res, link) => res + `\n${GOOHOME_DOMAIN}${link}`, "")
  return `新規物件が${links.length}件あります\n${linkStrings}`
}

const getLinks = async (url: string) => {
  const rowHtml = await fetch(url).then(res => res.text())
  const doc = new JSDOM(rowHtml).window.document
  return [...doc.querySelectorAll<HTMLAnchorElement>("#contents .detail_view_btn a")].map(link => link.href)
}

const getUserIds = async () => {
  const collection = await db.collection("users").withConverter(createConverter<{id: string}>()).get()
  return collection.docs.map(d => d.data().id)
}

/**
 * firestoreのデータに型をつけるためのutil
 */
const createConverter = <T extends Record<string, any>>() => {
  return {
    toFirestore(data: T): admin.firestore.DocumentData {
      return data
    },
    fromFirestore(snapshot: admin.firestore.QueryDocumentSnapshot): T {
      return snapshot.data() as T
    },
  }
}