import {logger} from "firebase-functions";
import {onCall} from "firebase-functions/v2/https";

import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const K = 32; // Elo rating K-factor

export const updateEloRating = onCall(async (request) => {
  logger.info("Received updateEloRating request", request.data);

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

  return {message: "Elo scores updated", entry1Id, newScore1: score1, entry2Id, newScore2: score2};
});
