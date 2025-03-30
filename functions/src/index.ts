import {logger, https} from "firebase-functions";
import {onCall} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const K = 32; // Elo rating K-factor

export const updateEloRating = onCall(async (request) => {

  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Unauthenticated: Sign-in required");
  }

  logger.info("Received updateEloRating request from UID: ", uid, request.data);

  const {collectionName, entry1Id, entry2Id, mode} = request.data;

  if (!collectionName || !entry1Id || !entry2Id) {
    throw new Error("Invalid request: Missing parameters");
  }

  const entry1Ref = db.collection("categories").doc(collectionName).collection("entries").doc(entry1Id);
  const entry2Ref = db.collection("categories").doc(collectionName).collection("entries").doc(entry2Id);

  const [entry1Doc, entry2Doc] = await Promise.all([entry1Ref.get(), entry2Ref.get()]);

  if (!entry1Doc.exists || !entry2Doc.exists) {
    throw new Error("One or both entries not found");
  }

  const entry1 = entry1Doc.data();
  const entry2 = entry2Doc.data();

  if (entry1 === undefined || entry2 === undefined) {
    throw new Error("One or both entries do not have a score");
  }

  const [idA, idB] = [entry1Id, entry2Id].sort(); // normalize
  const voteId = `${uid}_${collectionName}_${idA}_${idB}`;

  const voteRef = db.collection("votes").doc(voteId);
  const existingVote = await voteRef.get();
  if (existingVote.exists) {
    throw new Error("You've already ranked this pair.");
  }

  const expectedScore1 = 1 / (1 + Math.pow(10, (entry2.score - entry1.score) / 400));
  const expectedScore2 = 1 / (1 + Math.pow(10, (entry1.score - entry2.score) / 400));

  let score1 = entry1.score;
  let score2 = entry2.score;

  if (mode === 0) {
    score1 += K * (1 - expectedScore1);
    score2 += K * (0 - expectedScore2);
  } else if (mode === 1) {
    score1 += K * (0 - expectedScore1);
    score2 += K * (1 - expectedScore2);
  }

  await Promise.all([
    entry1Ref.update({score: score1}),
    entry2Ref.update({score: score2}),
  ]);

  await voteRef.set({
    uid,
    collection: collectionName,
    entryA: idA,
    entryB: idB,
    timestamp: new Date(),
  });


  return {message: "Elo scores updated", entry1Id, newScore1: score1, entry2Id, newScore2: score2, by: uid};
});

export const getClassYear = onCall(async (request) => {
  // Ensure authenticated
  const auth = request.auth;
  if (!auth || !auth.token || !auth.token.email) {
    throw new https.HttpsError("unauthenticated", "You must be logged in");
  }

  const email = auth.token.email;
  if (!email.endsWith("@yale.edu")) {
    throw new https.HttpsError("permission-denied", "Yale email required");
  }

  const apiKey = process.env.YALIES_API_KEY

  if (!apiKey) {
    throw new https.HttpsError("internal", "Yalies API key not configured");
  }

  const yaliesURL = "https://api.yalies.io/v2/people";
  const yaliesResponse = await fetch(yaliesURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({ filters: { email: email } }),
  });

  if (!yaliesResponse.ok) {
    logger.error("Yalies API error:", await yaliesResponse.text());
    throw new https.HttpsError("unavailable", "Failed to fetch Yalies data");
  }

  const yaliesJSON = await yaliesResponse.json();
  const classYear = yaliesJSON[0].year;

  return { classYear };
});