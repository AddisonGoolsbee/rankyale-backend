import {logger, https} from "firebase-functions";
import {onCall} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();

const subcategories = ["All", "Freshmen", "Sophomores", "Juniors", "Seniors"];

export const fetchTopEntries = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Unauthenticated: Sign-in required");
  }

  const collectionName = request.data.collection;
  if (!collectionName) {
    throw new Error("Missing collection name");
  }

  const results: Record<string, FirebaseFirestore.DocumentData[]> = {};

  for (const sub of subcategories) {
    let query = db.collection("categories")
      .doc(collectionName)
      .collection("entries")
      .orderBy("score", "desc")
      .limit(100);

    if (sub !== "All") {
      const classYear =
        sub === "Freshmen" ? 2028 :
          sub === "Sophomores" ? 2027 :
            sub === "Juniors" ? 2026 :
              sub === "Seniors" ? 2025 : null;

      if (classYear) {
        query = query.where("class_year", "==", classYear);
      }
    }

    const snap = await query.get();
    results[sub] = snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  }

  return results;
});

export const generateBuckets = onCall(async (request) => {
  const collectionName = request.data.collection;
  if (!collectionName) {
    throw new Error("Missing collection name");
  }

  const subcategories = {
    All: () => true,
    Seniors: (s: any) => s.class_year === 2025,
    Juniors: (s: any) => s.class_year === 2026,
    Sophomores: (s: any) => s.class_year === 2027,
    Freshmen: (s: any) => s.class_year === 2028,
  };

  const studentsSnap = await db
    .collection("categories")
    .doc(collectionName)
    .collection("entries")
    .get();

  const allStudents = studentsSnap.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  const batch = db.batch();
  const bucketsRef = db.collection("buckets");

  for (const [subcategory, filterFn] of Object.entries(subcategories)) {
    const pool = allStudents.filter(filterFn);

    for (let index = 0; index < 100; index++) {
      const pairs: string[][] = [];
      const seen = new Set<string>();

      while (pairs.length < 100 && pool.length >= 2) {
        const i1 = Math.floor(Math.random() * pool.length);
        let i2 = Math.floor(Math.random() * pool.length);
        while (i2 === i1) i2 = Math.floor(Math.random() * pool.length);

        const [idA, idB] = [pool[i1].id, pool[i2].id].sort();
        const key = `${idA}_${idB}`;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push([idA, idB]);
        }
      }

      const bucketId = `${collectionName}_${subcategory}_${index}`;
      const bucketDoc = bucketsRef.doc(bucketId);
      batch.set(bucketDoc, {
        collection: collectionName,
        subcategory,
        index,
        pairs: pairs.map(([a, b]) => ({a, b})),
        timestamp: new Date(),
      });

      if (index === 0) {
        console.log(`${subcategory} first 5 pairs:`, pairs.slice(0, 5));
      }
    }
  }

  await batch.commit();
  return {message: "Buckets generated and written to Firestore."};
});


const K = 32; // Elo rating K-factor
const MAX_DAILY_RANKINGS = 100;
export const updateEloRating = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Unauthenticated: Sign-in required");
  }

  const {collectionName, entry1Id, entry2Id, mode, subcategory} = request.data;

  if (!collectionName || !entry1Id || !entry2Id || !subcategory) {
    throw new Error("Invalid request: Missing parameters");
  }

  const userRef = db.collection("users").doc(uid);
  const entry1Ref = db.collection("categories").doc(collectionName).collection("entries").doc(entry1Id);
  const entry2Ref = db.collection("categories").doc(collectionName).collection("entries").doc(entry2Id);

  let score1; let score2; // Declare score1 and score2 here

  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    if (!userDoc.exists) {
      return {message: "User not found"};
    }

    const userData = userDoc.data();
    if (!userData) {
      return {message: "User data not found"};
    }

    if (userData.banned) {
      return {message: "You are banned from ranking"};
    }

    const today = new Date().toISOString().split("T")[0];

    // Initialize today's votes if not present
    if (!userData.votes.some((vote: any) => vote.date === today)) {
      userData.votes.push({
        date: today,
        All: 0,
        Freshmen: 0,
        Sophomores: 0,
        Juniors: 0,
        Seniors: 0,
      });
    }

    const todaysVotes = userData.votes.find((vote: any) => vote.date === today);
    if (todaysVotes[subcategory] >= MAX_DAILY_RANKINGS) {
      return {message: "No votes left for this category today"};
    }

    const [entry1Doc, entry2Doc] = await Promise.all([transaction.get(entry1Ref), transaction.get(entry2Ref)]);

    if (!entry1Doc.exists || !entry2Doc.exists) {
      return {message: "One or both entries not found"};
    }

    const entry1 = entry1Doc.data();
    const entry2 = entry2Doc.data();

    if (entry1 === undefined || entry2 === undefined) {
      return {message: "One or both entries do not have a score"};
    }

    const [idA, idB] = [entry1Id, entry2Id].sort(); // normalize
    const voteId = `${uid}_${collectionName}_${idA}_${idB}`;

    const voteRef = db.collection("votes").doc(voteId);
    const existingVote = await transaction.get(voteRef);
    if (existingVote.exists) {
      return {message: "You've already ranked this pair."};
    }

    const randomFactor = 0.01 * (Math.random() - 0.5); // Small random factor between -0.005 and 0.005
    const expectedScore1 = 1 / (1 + Math.pow(10, (entry2.score - entry1.score) / 400 + randomFactor));
    const expectedScore2 = 1 / (1 + Math.pow(10, (entry1.score - entry2.score) / 400 + randomFactor));

    score1 = entry1.score;
    score2 = entry2.score;

    if (mode === 0) {
      score1 += K * (1 - expectedScore1);
      score2 += K * (0 - expectedScore2);
    } else if (mode === 1) {
      score1 += K * (0 - expectedScore1);
      score2 += K * (1 - expectedScore2);
    }

    transaction.update(entry1Ref, {score: score1});
    transaction.update(entry2Ref, {score: score2});

    transaction.set(voteRef, {
      uid,
      collection: collectionName,
      entryA: idA,
      entryB: idB,
      winner: mode === 0 ? idA : idB,
      timestamp: new Date(),
    });

    // Update the votes count
    todaysVotes[subcategory] += 1;
    transaction.update(userRef, {votes: userData.votes});

    return {message: "Elo scores updated", entry1Id, newScore1: score1, entry2Id, newScore2: score2, by: uid};
  });
});

export const getUser = onCall(async (request) => {
  // Ensure authenticated
  const auth = request.auth;
  if (!auth || !auth.token || !auth.token.email) {
    throw new https.HttpsError("unauthenticated", "You must be logged in");
  }

  const email = auth.token.email;
  if (!email.endsWith("@yale.edu")) {
    throw new https.HttpsError("permission-denied", "Yale email required");
  }

  const uid = auth.uid;
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    // Create a new user document if it doesn't exist
    await userRef.set({
      email: email,
      votes: [],
    });
  }

  // Fetch the user's document again to ensure it exists
  const updatedUserDoc = await userRef.get();
  const userData = updatedUserDoc.data();

  if (!userData) {
    throw new https.HttpsError("not-found", "User data not found");
  }

  if (!userData.classYear) {
    const apiKey = process.env.YALIES_API_KEY;
    if (!apiKey) {
      throw new https.HttpsError("internal", "Yalies API key not configured");
    }

    const yaliesURL = "https://api.yalies.io/v2/people";
    const yaliesResponse = await fetch(yaliesURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({filters: {email: email}}),
    });

    if (!yaliesResponse.ok) {
      logger.error("Yalies API error:", await yaliesResponse.text());
      throw new https.HttpsError("unavailable", "Failed to fetch Yalies data");
    }

    const yaliesJSON = await yaliesResponse.json();
    const classYear = yaliesJSON[0].year;

    // Update the user's class year
    await userRef.update({classYear});
  }

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });


  // Initialize today's votes if not present
  if (!userData.votes.some((vote: any) => vote.date === today)) {
    userData.votes.push({
      date: today,
      All: 0,
      Freshmen: 0,
      Sophomores: 0,
      Juniors: 0,
      Seniors: 0,
    });

    // Persist the changes to Firestore
    await userRef.update({votes: userData.votes});
  }

  const todaysVotes = userData.votes.find((vote: any) => vote.date === today);
  return {email, classYear: userData.classYear, todaysVotes};
});

export const fetchVotesAndGeneratePairs = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Unauthenticated: Sign-in required");
  }

  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    throw new Error("User not found");
  }

  const userData = userDoc.data();
  if (!userData) {
    throw new Error("User data not found");
  }

  const today = new Date().toISOString().split("T")[0];
  const todaysVotes = userData.votes.find((vote: any) => vote.date === today);

  if (!todaysVotes) {
    return [];
  }

  const subset = request.data.subset || "All";
  const remainingVotes = MAX_DAILY_RANKINGS - (todaysVotes[subset] || 0);

  if (remainingVotes <= 0) {
    return [];
  }

  const votesSnap = await db.collection("votes")
    .where("uid", "==", uid)
    .where("collection", "==", request.data.collection)
    .get();

  const seenPairs = new Set<string>();
  votesSnap.forEach((doc) => {
    const {entryA, entryB} = doc.data();
    seenPairs.add(`${entryA}_${entryB}`);
  });

  const studentsSnap = await db.collection("categories").doc(request.data.collection).collection("entries").get();

  const filtered = studentsSnap.docs.filter((doc) => {
    const data = doc.data();
    if (subset === "All") return true;
    const classYear = data.class_year;
    switch (subset) {
    case "Freshmen":
      return classYear === 2028;
    case "Sophomores":
      return classYear === 2027;
    case "Juniors":
      return classYear === 2026;
    case "Seniors":
      return classYear === 2025;
    default:
      return false;
    }
  });

  const randomPairs: { entry1: number; entry2: number }[] = [];
  let attempts = 0;

  while (randomPairs.length < remainingVotes && attempts < 1000) {
    const i1 = Math.floor(Math.random() * filtered.length);
    let i2 = Math.floor(Math.random() * filtered.length);

    while (i2 === i1) {
      i2 = Math.floor(Math.random() * filtered.length);
    }

    const [idA, idB] = [filtered[i1].id, filtered[i2].id].sort();
    const pairKey = `${idA}_${idB}`;

    const alreadyInList = randomPairs.some((pair) => {
      const [a, b] = [
        filtered[pair.entry1].id,
        filtered[pair.entry2].id,
      ].sort();
      return `${a}_${b}` === pairKey;
    });

    if (!seenPairs.has(pairKey) && !alreadyInList) {
      randomPairs.push({entry1: i1, entry2: i2});
    }

    attempts++;
  }
  return randomPairs;
});

export const fetchRandomBuckets = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("Unauthenticated: Sign-in required");
  }

  const collectionName = request.data.collection;
  if (!collectionName) {
    throw new Error("Missing collection name");
  }

  const subcategories = ["All", "Freshmen", "Sophomores", "Juniors", "Seniors"];
  const result: Record<string, { a: string; b: string }[]> = {};

  for (const sub of subcategories) {
    const index = Math.floor(Math.random() * 100);
    const bucketId = `${collectionName}_${sub}_${index}`;
    const doc = await db.collection("buckets").doc(bucketId).get();
    if (doc.exists) {
      result[sub] = doc.data()?.pairs || [];
    } else {
      result[sub] = [];
    }
  }

  return result;
});

export const getEntriesFromPairs = onCall(async (request) => {
  const {collection, pairs} = request.data;

  if (!collection || !Array.isArray(pairs) || pairs.length !== 100) {
    throw new Error("Missing or invalid parameters");
  }

  const ids = Array.from(
    new Set(pairs.flatMap(({a, b}: { a: string; b: string }) => [a, b]))
  );

  const refs = ids.map((id) =>
    db.collection("categories").doc(collection).collection("entries").doc(id)
  );

  const docs = await Promise.all(refs.map((ref) => ref.get()));
  const entries = Object.fromEntries(
    docs.filter((doc) => doc.exists).map((doc) => [doc.id, doc.data()])
  );

  return entries;
});
