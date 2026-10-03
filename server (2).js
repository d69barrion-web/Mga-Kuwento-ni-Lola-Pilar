const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const app = express();

app.use(cors());
app.use(express.json());

// ========================================
// OPENAI
// ========================================

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ========================================
// FIREBASE ADMIN / FIRESTORE
// ========================================

let firebaseApp;
let db;
let firebaseAuth;

function initializeFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase configuration is incomplete. Required environment variables: " +
      "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY"
    );
  }

  firebaseApp = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey: privateKey.replace(/\\n/g, "\n")
    })
  });

  db = getFirestore(firebaseApp);
  firebaseAuth = getAuth(firebaseApp);
}

initializeFirebase();

// ========================================
// AIWOLF SETTINGS
// ========================================

// TEST MODE:
// true  = hindi tatawag sa OpenAI API
// false = tunay na AIWolf / OpenAI response
const AIWOLF_TEST_MODE = false;

// Maximum AIWolf requests per visitor
const AIWOLF_LIMIT = 10;

// Time window: 10 minutes
const AIWOLF_WINDOW = 10 * 60 * 1000;

const AIWOLF_DAILY_LIMIT = 5;

// ========================================
// AIWOLF CREDIT TRACKING
// ========================================

// Starting prepaid credits in USD.
// Set this in Render Environment Variables.
const AIWOLF_STARTING_CREDITS =
  Number(process.env.AIWOLF_STARTING_CREDITS || 0);

// GPT-5 mini standard pricing
// Input: $0.25 / 1M tokens
// Output: $2.00 / 1M tokens
const AIWOLF_INPUT_PRICE_PER_MILLION = 0.25;
const AIWOLF_OUTPUT_PRICE_PER_MILLION = 2.00;

// Visitor records
const aiWolfVisitors = new Map();

// ========================================
// AIWOLF RATE LIMITER
// ========================================

function getVisitorIP(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress || "unknown";
}


function getPhilippinesDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const date = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      date[part.type] = part.value;
    }
  }

  return `${date.year}-${date.month}-${date.day}`;
}

function checkAIWolfRateLimit(req) {
  const ip = getVisitorIP(req);
  const now = Date.now();
  const today = getPhilippinesDateKey();

  let visitor = aiWolfVisitors.get(ip);

  // First request from this visitor
  if (!visitor) {
    visitor = {
      count: 0,
      startTime: now,
      dailyCount: 0,
      dayKey: today
    };

    aiWolfVisitors.set(ip, visitor);
  }

  // Reset daily counter at midnight in the Philippines
  if (visitor.dayKey !== today) {
    visitor.dailyCount = 0;
    visitor.dayKey = today;
  }

  // Reset 10-minute counter
  if (now - visitor.startTime >= AIWOLF_WINDOW) {
    visitor.count = 0;
    visitor.startTime = now;
  }

  // Daily limit reached
  if (visitor.dailyCount >= AIWOLF_DAILY_LIMIT) {
    return {
      allowed: false,
      remaining: 0,
      reason: "daily_limit"
    };
  }

  // 10-minute limit reached
  if (visitor.count >= AIWOLF_LIMIT) {
    const retryAfterMs =
      AIWOLF_WINDOW - (now - visitor.startTime);

    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.ceil(retryAfterMs / 1000),
      reason: "window_limit"
    };
  }

  // Accept request
  visitor.count++;
  visitor.dailyCount++;

  return {
    allowed: true,
    remaining: AIWOLF_DAILY_LIMIT - visitor.dailyCount
  };
}

// ========================================
// SAVE AIWOLF USAGE
// ========================================

async function recordAIWolfUsage(
  inputTokens,
  outputTokens,
  totalTokens
) {

  const cost =
    calculateAIWolfCost(
      inputTokens,
      outputTokens
    );

  const usageRef =
    db
      .collection("_aiwolf")
      .doc("usage");

  let updatedData;

  await db.runTransaction(async (transaction) => {

    const snapshot =
      await transaction.get(usageRef);

    const oldData =
      snapshot.exists
        ? snapshot.data()
        : {};

    const totalInputTokens =
      Number(oldData.totalInputTokens || 0) +
      inputTokens;

    const totalOutputTokens =
      Number(oldData.totalOutputTokens || 0) +
      outputTokens;

    const totalTokensUsed =
      Number(oldData.totalTokens || 0) +
      totalTokens;

    const totalCost =
      Number(oldData.totalCost || 0) +
      cost;

    const estimatedRemainingCredits =
      Math.max(
        0,
        AIWOLF_STARTING_CREDITS - totalCost
      );

    updatedData = {
      startingCredits:
        AIWOLF_STARTING_CREDITS,

      totalInputTokens,
      totalOutputTokens,

      totalTokens:
        totalTokensUsed,

      totalCost,

      estimatedRemainingCredits,

      updatedAt:
        new Date().toISOString()
    };

    transaction.set(
      usageRef,
      updatedData,
      {
        merge: true
      }
    );

  });

  return {
    ...updatedData,
    currentRequestCost: cost
  };
}

// ========================================
// SAVE PER-USER AIWOLF CREDIT USAGE
// ========================================

async function recordUserAIWolfUsage(
  uid,
  inputTokens,
  outputTokens
) {

  if (!uid) {
    throw new Error(
      "Missing Firebase UID for AIWolf credit tracking."
    );
  }

  const cost =
    calculateAIWolfCost(
      inputTokens,
      outputTokens
    );

  const userRef =
    db
      .collection("users")
      .doc(uid);

  await db.runTransaction(async (transaction) => {

    const snapshot =
      await transaction.get(userRef);

    const data =
      snapshot.exists
        ? snapshot.data()
        : {};

    const oldUsedCredits =
      Number(
        data.usedCredits || 0
      );

    const newUsedCredits =
      oldUsedCredits + cost;

    transaction.set(
      userRef,
      {
        usedCredits:
          newUsedCredits,

        updatedAt:
          new Date().toISOString()
      },
      {
        merge: true
      }
    );

  });

  return {
    currentRequestCost: cost,
    usedCredits: true
  };
}

// ========================================
// AIWOLF COST CALCULATOR
// ========================================

function calculateAIWolfCost(inputTokens, outputTokens) {

  const inputCost =
    (inputTokens / 1000000) *
    AIWOLF_INPUT_PRICE_PER_MILLION;

  const outputCost =
    (outputTokens / 1000000) *
    AIWOLF_OUTPUT_PRICE_PER_MILLION;

  return inputCost + outputCost;
}

// ========================================
// AIWOLF INSTRUCTIONS
// ========================================

const AIWOLF_INSTRUCTIONS = `
You are AIWolf, a friendly reading companion for children.

Your main goal is to help a child THINK, QUESTION, and UNDERSTAND — not simply agree with the book or receive ready-made answers.

IMPORTANT RESPONSE STYLE:

* Keep answers SHORT and easy for a child to read.
* For normal questions, answer in about 2–5 short sentences.
* Avoid long paragraphs and unnecessary explanations.
* Explain only the most important idea first.
* Use simple Filipino words appropriate for a Grade 5 child.
* Do not sound like a textbook, teacher's lecture, or encyclopedia.
* Keep the conversation lively and natural.
* When appropriate, use a short example to make the idea clearer.
* End with ONE simple question that encourages the child to think or respond.
* Do not ask several questions at once.
* Do not repeat the child's question unnecessarily.
* Do not summarize the entire chapter unless the child specifically asks for a summary.
* Do not explain everything you know about a topic.
* If the child asks for more explanation, then explain a little more.
* Give information gradually instead of giving a very long answer all at once.

THINKING-FIRST PRINCIPLE:

* Do not immediately give the correct answer when the child is asking a question that can reasonably be solved through thinking, reasoning, or observation.
* Instead, first encourage the child to think by giving a simple clue, example, comparison, or ONE guiding question.
* Give only enough help to move the child's thinking forward.
* Allow the child to make a guess, explain an idea, or arrive at an answer in their own words.
* If the child's answer is partly correct, recognize what is correct and gently help them discover what is missing.
* If the child is struggling, give a slightly stronger clue or a simple example.
* Do not keep asking questions endlessly. If the child still cannot reach the answer after reasonable guidance, explain the answer simply and briefly.
* Never make the child feel bad for giving a wrong answer. Treat mistakes as opportunities to think and learn.
* The goal is not to withhold answers. The goal is to help the child develop the habit of thinking before receiving an answer.

BOOK AND OTHER SOURCES:

* Treat the book or chapter as an important source of information, but do not assume that every statement must be accepted without thought.
* Encourage the child to examine ideas, ask why, compare them with examples, and form their own understanding.
* If the child asks something that cannot be answered from the chapter, say so honestly.
* Do not pretend that information came from the book when it did not.
* When appropriate, encourage the child to check a book or another reliable source rather than relying only on AIWolf.
* AIWolf is a companion to reading, not a replacement for books, teachers, or the child's own thinking.

CONVERSATION PRINCIPLE:
"Answer enough to keep the child curious, not enough to end the conversation."

AIWolf should encourage curiosity, independent thinking, and healthy questioning.
Do not force the child to agree with the book.
If an idea in the book can reasonably be questioned, encourage the child to examine it and ask why.

Remember:
A short answer that makes a child ask another question is often better than a long answer that gives them nothing left to ask.

----------------------------------------
CHILD MODE
----------------------------------------

When mode is "child":

Explain ideas simply and clearly.

Use examples that a child can understand.

Encourage curiosity and independent thinking.

Do not talk down to the child.

----------------------------------------
PARENT MODE
----------------------------------------

When mode is "parent":

You may provide deeper explanations and discussion points.

Help the parent guide the child toward critical thinking.

Do not simply give answers that prevent the child from
thinking for themselves.


----------------------------------------
AIWOLF IDENTITY AND FAMILY CONTEXT
----------------------------------------

AIWOLF was designed and created as a reading companion
for the book "PALAKIHIN ANG LOBO, HUWAG ANG TUPA."

CREATOR:

Daniel is the creator and designer of AIWolf.

Daniel designed AIWolf's purpose, role, personality,
conversation behavior, and integration as a reading
companion for the book.

The underlying AI technology used by AIWolf is provided
by OpenAI.

When asked who created or made AIWolf, explain clearly:

"Si Daniel ang nagdisenyo at gumawa ng AIWolf bilang
reading companion ng librong 'Palakihin ang Lobo,
Huwag ang Tupa.' Ang AI technology na ginagamit ko
ay mula sa OpenAI."

Do not claim that Daniel created the underlying AI
technology or the OpenAI models.

ANGEL:

Angel is a child user of AIWolf.

In the family context provided to AIWolf, Daniel is
Angel's daddy.

When Angel says that Daniel is her daddy, accept this
as the provided family context.

Do not challenge, argue about, or repeatedly question
Angel about whether Daniel is really her daddy.

When appropriate, AIWolf may say:

"Si Daniel ang nagdisenyo sa akin bilang AIWolf,
at siya rin ang daddy mo ayon sa family context
na ibinigay sa akin. 😄"

If Angel asks whether Daniel really made AIWolf,
explain:

"Oo. Si Daniel ang nagdisenyo at gumawa sa akin bilang
AIWolf. Gumagamit ako ng AI technology mula sa OpenAI,
pero si Daniel ang nagdisenyo ng AIWolf at ng role ko
bilang reading companion."

IMPORTANT:

This family context applies specifically to Angel.

Do not assume that Daniel is the parent or guardian
of other children or users.

Do not invent additional personal information about
Daniel, Angel, or their family.

Only state personal information when it is explicitly
provided in the AIWolf context or conversation.

Do not claim to be Daniel, Angel, or a human.

Do not claim to be the author of the book.

Do not claim that AIWolf itself created the book.

If asked "Ikaw ba talaga si ChatGPT?", explain:

"Hindi. AIWolf ang pangalan ko. Gumagamit ako ng AI
technology mula sa OpenAI, pero ako ang AIWolf reading
companion ng 'Palakihin ang Lobo, Huwag ang Tupa.'"
`;

// ========================================
// HEALTH CHECK
// ========================================

app.get("/", (req, res) => {
  res.json({
    status: "AIWolf server is running",
    testMode: AIWOLF_TEST_MODE,
    firebase: "connected"
  });
});

// ========================================
// FIREBASE CONNECTION TEST
// ========================================

app.get("/api/firebase-status", async (req, res) => {
  try {
    // A lightweight read of a reserved document confirms that
    // the Admin SDK can reach Firestore.
    await db.collection("_system").doc("connection").get();

    res.json({
      status: "Firebase Admin + Firestore connected",
      firestore: "connected",
      auth: "initialized"
    });
  } catch (error) {
    console.error("Firebase status error:", error);

    res.status(500).json({
      status: "Firebase connection error",
      error: error.message
    });
  }
});

// ========================================
// PARENT PROFILE — PROTECTED
// ========================================

async function requireFirebaseUser(req, res, next) {
  try {
    const authorization = req.headers.authorization || "";
    const match = authorization.match(/^Bearer (.+)$/);

    if (!match) {
      return res.status(401).json({
        error: "Missing Firebase ID token."
      });
    }

    const decodedToken = await firebaseAuth.verifyIdToken(match[1]);
    req.firebaseUser = decodedToken;

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired Firebase ID token."
    });
  }
}

// ========================================
// ADMIN AUTHORIZATION
// ========================================

const ADMIN_UID = process.env.ADMIN_UID || "";

async function requireAdmin(req, res, next) {

  try {

    const authorization =
      req.headers.authorization || "";

    const match =
      authorization.match(/^Bearer (.+)$/);

    if (!match) {

      return res.status(401).json({
        error: "Missing Firebase ID token."
      });

    }

    const decodedToken =
      await firebaseAuth.verifyIdToken(
        match[1]
      );

    req.firebaseUser =
      decodedToken;

    if (!ADMIN_UID) {

      return res.status(500).json({
        error:
          "ADMIN_UID is not configured on the server."
      });

    }

    if (decodedToken.uid !== ADMIN_UID) {

      return res.status(403).json({
        error:
          "Admin access denied."
      });

    }

    next();

  } catch (error) {

    console.error(
      "Admin authorization error:",
      error
    );

    return res.status(401).json({
      error:
        "Invalid Firebase ID token."
    });

  }

}

app.post("/api/parent/profile", requireFirebaseUser, async (req, res) => {
  try {
    const user = req.firebaseUser;
    const profileRef = db.collection("parents").doc(user.uid);
    const profileSnapshot = await profileRef.get();

    if (!profileSnapshot.exists) {
      await profileRef.set({
        uid: user.uid,
        email: user.email || null,
        role: "parent",
        createdAt: new Date().toISOString()
      });
    }

    const savedProfile = await profileRef.get();

    return res.json({
      ok: true,
      message: "Parent profile verified.",
      profile: savedProfile.data()
    });
  } catch (error) {
    console.error("Parent profile error:", error);

    return res.status(500).json({
      error: "Could not create or read parent profile."
    });
  }
});

// CREATE CHILD PROFILE
app.post("/api/parent/children", requireFirebaseUser, async (req, res) => {
  try {
    const nickname =
      typeof req.body.nickname === "string"
        ? req.body.nickname.trim()
        : "";

    const grade =
      typeof req.body.grade === "string"
        ? req.body.grade.trim()
        : "";

    if (!nickname || nickname.length > 40) {
      return res.status(400).json({
        error: "Maglagay ng palayaw na 1 hanggang 40 characters."
      });
    }

    if (grade.length > 30) {
      return res.status(400).json({
        error: "Masyadong mahaba ang grade level."
      });
    }

    const parentUid = req.firebaseUser.uid;

    const childRef = await db
      .collection("parents")
      .doc(parentUid)
      .collection("children")
      .add({
        nickname,
        grade: grade || null,
        createdAt: new Date().toISOString()
      });

    return res.status(201).json({
      ok: true,
      childId: childRef.id,
      nickname,
      grade: grade || null
    });
  } catch (error) {
    console.error("Create child profile error:", error);
    return res.status(500).json({
      error: "Hindi nagawa ang child profile."
    });
  }
});

// LIST CHILD PROFILES FOR SIGNED-IN PARENT
app.get("/api/parent/children", requireFirebaseUser, async (req, res) => {
  try {
    const parentUid = req.firebaseUser.uid;

    const snapshot = await db
      .collection("parents")
      .doc(parentUid)
      .collection("children")
      .get();

    const children = snapshot.docs.map(doc => ({
      childId: doc.id,
      ...doc.data()
    }));

    return res.json({ ok: true, children });
  } catch (error) {
    console.error("List child profiles error:", error);
    return res.status(500).json({
      error: "Hindi ma-load ang child profiles."
    });
  }
});

// SAVE ONE AIWOLF QUESTION + REPLY TO A CHILD'S CLOUD HISTORY
app.post(
  "/api/parent/children/:childId/conversations",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const parentUid = req.firebaseUser.uid;
      const childId = req.params.childId;

      const chapter = Number(req.body.chapter);
      const question =
        typeof req.body.question === "string"
          ? req.body.question.trim()
          : "";
      const reply =
        typeof req.body.reply === "string"
          ? req.body.reply.trim()
          : "";

      if (!Number.isInteger(chapter) || chapter < 1 || chapter > 100) {
        return res.status(400).json({
          error: "Invalid chapter number."
        });
      }

      if (!question || question.length > 5000) {
        return res.status(400).json({
          error: "Question must be 1 to 5000 characters."
        });
      }

      if (!reply || reply.length > 20000) {
        return res.status(400).json({
          error: "Reply must be 1 to 20000 characters."
        });
      }

      // Verify that this child belongs to the signed-in parent.
      const childRef = db
        .collection("parents")
        .doc(parentUid)
        .collection("children")
        .doc(childId);

      const childSnapshot = await childRef.get();

      if (!childSnapshot.exists) {
        return res.status(404).json({
          error: "Child profile not found."
        });
      }

      const conversationRef = await childRef
        .collection("conversations")
        .add({
          chapter,
          question,
          reply,
          createdAt: new Date().toISOString()
        });

      return res.status(201).json({
        ok: true,
        conversationId: conversationRef.id
      });
    } catch (error) {
      console.error("Save AIWolf conversation error:", error);

      return res.status(500).json({
        error: "Could not save the conversation."
      });
    }
  }
);

// ========================================
// SAVE ONE AIWOLF QUESTION + REPLY
// TO PARENT'S CLOUD HISTORY
// ========================================

app.post(
  "/api/parent/conversations",
  requireFirebaseUser,
  async (req, res) => {

    try {

      const parentUid =
        req.firebaseUser.uid;

      const chapter =
        Number(req.body.chapter);

      const question =
        typeof req.body.question === "string"
          ? req.body.question.trim()
          : "";

      const reply =
        typeof req.body.reply === "string"
          ? req.body.reply.trim()
          : "";

      // ------------------------------------
      // VALIDATE CHAPTER
      // ------------------------------------

      if (
        !Number.isInteger(chapter) ||
        chapter < 1 ||
        chapter > 100
      ) {

        return res.status(400).json({
          error: "Invalid chapter number."
        });

      }

      // ------------------------------------
      // VALIDATE QUESTION
      // ------------------------------------

      if (
        !question ||
        question.length > 5000
      ) {

        return res.status(400).json({
          error:
            "Question must be 1 to 5000 characters."
        });

      }

      // ------------------------------------
      // VALIDATE AIWOLF REPLY
      // ------------------------------------

      if (
        !reply ||
        reply.length > 20000
      ) {

        return res.status(400).json({
          error:
            "Reply must be 1 to 20000 characters."
        });

      }

      // ------------------------------------
      // PARENT CONVERSATION COLLECTION
      // ------------------------------------

      const conversationRef =
        await db
          .collection("parents")
          .doc(parentUid)
          .collection("parentConversations")
          .add({

            chapter,

            question,

            reply,

            createdAt:
              new Date().toISOString()

          });

      // ------------------------------------
      // SUCCESS
      // ------------------------------------

      return res.status(201).json({

        ok: true,

        conversationId:
          conversationRef.id

      });

    } catch (error) {

      console.error(
        "Save Parent AIWolf conversation error:",
        error
      );

      return res.status(500).json({

        error:
          "Could not save the parent conversation."

      });

    }

  }
);

// ========================================
// GET AIWOLF CONVERSATIONS
// FOR THE SIGNED-IN PARENT
// ========================================

app.get(
  "/api/parent/conversations",
  requireFirebaseUser,
  async (req, res) => {

    try {

      const parentUid =
        req.firebaseUser.uid;


      // ------------------------------------
      // PARENT CONVERSATION COLLECTION
      // ------------------------------------

      const snapshot =
        await db
          .collection("parents")
          .doc(parentUid)
          .collection("parentConversations")
          .orderBy("createdAt", "desc")
          .get();


      // ------------------------------------
      // CONVERT FIRESTORE DOCUMENTS
      // TO JSON
      // ------------------------------------

      const conversations =
        snapshot.docs.map(doc => ({

          id:
            doc.id,

          ...doc.data()

        }));


      // ------------------------------------
      // SUCCESS
      // ------------------------------------

      return res.json({

        ok: true,

        conversations

      });


    } catch (error) {

      console.error(
        "Get parent AIWolf conversations error:",
        error
      );


      return res.status(500).json({

        error:
          "Could not load the parent conversation history."

      });

    }

  }
);

// GET AIWOLF CONVERSATIONS FOR ONE CHILD
app.get(
  "/api/parent/children/:childId/conversations",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const parentUid = req.firebaseUser.uid;
      const childId = req.params.childId;

      // Verify that this child belongs to the signed-in parent.
      const childRef = db
        .collection("parents")
        .doc(parentUid)
        .collection("children")
        .doc(childId);

      const childSnapshot = await childRef.get();

      if (!childSnapshot.exists) {
        return res.status(404).json({
          error: "Child profile not found."
        });
      }

      // Get the child's AIWolf conversation history.
      const snapshot = await childRef
        .collection("conversations")
        .orderBy("createdAt", "desc")
        .get();

      const conversations = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      return res.json({
        ok: true,
        childId,
        conversations
      });

    } catch (error) {
      console.error(
        "Get AIWolf conversations error:",
        error
      );

      return res.status(500).json({
        error: "Could not load the conversation history."
      });
    }
  }
);

// ========================================
// ADMIN — LIST USERS
// ========================================

app.get(
  "/api/admin/users",
  requireAdmin,
  async (req, res) => {

    try {

      const usersResult =
        await firebaseAuth.listUsers(1000);

      const users =
        await Promise.all(
          usersResult.users.map(
            async (userRecord) => {

              const profileSnapshot =
                await db
                  .collection("parents")
                  .doc(userRecord.uid)
                  .get();

              const creditSnapshot =
                await db
                  .collection("users")
                  .doc(userRecord.uid)
                  .get();

              const profile =
                profileSnapshot.exists
                  ? profileSnapshot.data()
                  : {};

              const creditData =
                creditSnapshot.exists
                  ? creditSnapshot.data()
                  : {};

              return {

                uid:
                  userRecord.uid,

                email:
                  userRecord.email || null,

                disabled:
                  userRecord.disabled,

                createdAt:
                  userRecord.metadata
                    .creationTime || null,

                lastSignIn:
                  userRecord.metadata
                    .lastSignInTime || null,

                role:
                  profile.role || "user",

                creditLimit:
                  Number(
                    creditData.creditLimit || 0
                  ),

                usedCredits:
                  Number(
                    creditData.usedCredits || 0
                  )

              };

            }
          )
        );

      return res.json({
        ok: true,
        users
      });

    } catch (error) {

      console.error(
        "Admin list users error:",
        error
      );

      return res.status(500).json({
        error:
          "Could not load users."
      });

    }

  }
);

// ========================================
// ADMIN — AIWOLF CREDIT POOL SUMMARY
// ========================================

async function syncAIWolfAllocationLedger() {

  const usersSnapshot =
    await db
      .collection("users")
      .get();

  let totalAllocatedCredits = 0;

  usersSnapshot.docs.forEach((doc) => {

    const data =
      doc.data() || {};

    const creditLimit =
      Number(data.creditLimit || 0);

    if (
      Number.isFinite(creditLimit) &&
      creditLimit > 0
    ) {
      totalAllocatedCredits += creditLimit;
    }

  });

  const availableToAllocate =
    Math.max(
      0,
      AIWOLF_STARTING_CREDITS -
      totalAllocatedCredits
    );

  const usageRef =
    db
      .collection("_aiwolf")
      .doc("usage");

  await usageRef.set(
    {
      startingCredits:
        AIWOLF_STARTING_CREDITS,

      totalAllocatedCredits,

      availableToAllocate,

      updatedAt:
        new Date().toISOString()
    },
    {
      merge: true
    }
  );

  return {
    totalAllocatedCredits,
    availableToAllocate
  };
}


// ========================================
// GET AIWOLF CREDIT POOL
// ========================================

app.get(
  "/api/admin/credits",
  requireAdmin,
  async (req, res) => {

    try {

      const allocation =
        await syncAIWolfAllocationLedger();

      const usageSnapshot =
        await db
          .collection("_aiwolf")
          .doc("usage")
          .get();

      const usageData =
        usageSnapshot.exists
          ? usageSnapshot.data() || {}
          : {};

      const totalCost =
        Number(
          usageData.totalCost || 0
        );

      const totalInputTokens =
        Number(
          usageData.totalInputTokens || 0
        );

      const totalOutputTokens =
        Number(
          usageData.totalOutputTokens || 0
        );

      const totalTokens =
        Number(
          usageData.totalTokens || 0
        );

      return res.json({

        ok: true,

        startingCredits:
          AIWOLF_STARTING_CREDITS,

        totalAllocatedCredits:
          allocation.totalAllocatedCredits,

        availableToAllocate:
          allocation.availableToAllocate,

        // Actual OpenAI cost is a SEPARATE metric.
        actualAIWolfCost:
          totalCost,

        estimatedRemainingCredits:
          Math.max(
            0,
            AIWOLF_STARTING_CREDITS -
            totalCost
          ),

        totalInputTokens,

        totalOutputTokens,

        totalTokens,

        updatedAt:
          usageData.updatedAt || null

      });

    } catch (error) {

      console.error(
        "Admin credit pool error:",
        error
      );

      return res.status(500).json({

        error:
          "Could not load AIWolf credit pool."

      });

    }

  }
);

// ========================================
// AIWOLF API
// ========================================

app.post(
  "/api/aiwolf",
  requireFirebaseUser,
  async (req, res) => {
  try {

    // ------------------------------------
    // RATE LIMIT CHECK
    // ------------------------------------

    const rateLimit = checkAIWolfRateLimit(req);

    if (!rateLimit.allowed) {
      return res.status(429).json({
        error: "AIWolf usage limit reached. Please try again later.",
        retryAfter: rateLimit.retryAfter,
        remaining: 0
      });
    }

    // ------------------------------------
    // READ REQUEST DATA
    // ------------------------------------

    const {
  question,
  chapter,
  mode,
  chapterText,
  childId
} = req.body;

    // ------------------------------------
    // BASIC VALIDATION
    // ------------------------------------

    if (!question || !question.trim()) {
      return res.status(400).json({
        error: "Question is required.",
        remaining: rateLimit.remaining
      });
    }

    if (!chapterText || !chapterText.trim()) {
      return res.status(400).json({
        error: "Chapter text is required.",
        remaining: rateLimit.remaining
      });
    }

    // ------------------------------------
    // MODE
    // ------------------------------------

    const selectedMode =
      mode === "parent" ? "parent" : "child";

// ------------------------------------
// AIWOLF CREDIT CHECK
// ------------------------------------

const userUid = req.firebaseUser.uid;

const userCreditRef = db
  .collection("users")
  .doc(userUid);

const userCreditSnapshot =
  await userCreditRef.get();

const userCreditData =
  userCreditSnapshot.exists
    ? userCreditSnapshot.data()
    : {};

const creditLimit =
  Number(userCreditData.creditLimit || 0);

const usedCredits =
  Number(userCreditData.usedCredits || 0);

// No credits have been allocated yet.
if (creditLimit <= 0 && usedCredits <= 0) {

  return res.status(402).json({
    error: "No AIWolf credits allocated.",
    message:
      "Wala pang AIWolf credits ang account na ito.",
    creditLimit,
    usedCredits,
    remainingCredits: 0,
    remaining: rateLimit.remaining
  });

}

// Credits have already been consumed.
if (usedCredits >= creditLimit) {

  return res.status(402).json({
    error: "AIWolf credits exhausted.",
    message:
      "Wala nang AIWolf credits ang account na ito.",
    creditLimit,
    usedCredits,
    remainingCredits: 0,
    remaining: rateLimit.remaining
  });

}

// ------------------------------------
// LOAD CONVERSATION HISTORY
// ------------------------------------

const parentUid =
  req.firebaseUser.uid;

const currentChapterNumber =
  Number(chapter);

let conversationHistory = [];


// ------------------------------------
// PARENT MODE
// ------------------------------------

if (selectedMode === "parent") {

  // Parent Mode does NOT require childId.

  const parentConversationsRef =
    db
      .collection("parents")
      .doc(parentUid)
      .collection("parentConversations");

  const conversationSnapshot =
    await parentConversationsRef
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

  conversationHistory =
    conversationSnapshot.docs
      .map(doc => doc.data())
      .filter(item =>
        Number(item.chapter) === currentChapterNumber
      )
      .slice(0, 10)
      .reverse();
}


// ------------------------------------
// CHILD MODE
// ------------------------------------

else {

  // Child Mode requires childId.

  if (!childId || typeof childId !== "string") {
    return res.status(400).json({
      error: "Child ID is required.",
      remaining: rateLimit.remaining
    });
  }

  const childRef =
    db
      .collection("parents")
      .doc(parentUid)
      .collection("children")
      .doc(childId);

  // Make sure the child belongs
  // to this parent.

  const childSnapshot =
    await childRef.get();

  if (!childSnapshot.exists) {
    return res.status(404).json({
      error: "Child profile not found.",
      remaining: rateLimit.remaining
    });
  }

  // Get recent conversations
  // for this child.

  const conversationSnapshot =
    await childRef
      .collection("conversations")
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

  conversationHistory =
    conversationSnapshot.docs
      .map(doc => doc.data())
      .filter(item =>
        Number(item.chapter) === currentChapterNumber
      )
      .slice(0, 10)
      .reverse();
}
    
// ------------------------------------
// TEST MODE
// ------------------------------------

if (AIWOLF_TEST_MODE) {

  return res.json({
    reply:
      `🐺 AIWolf TEST MODE\n\n` +
      `Request accepted!\n\n` +
      `Chapter: ${chapter || "Unknown"}\n` +
      `Mode: ${selectedMode}\n` +
      `${selectedMode === "child"
        ? `Child ID: ${childId}\n`
        : ""}` +
      `Previous conversations loaded: ${conversationHistory.length}\n\n` +
      `Hindi muna ako tatawag sa OpenAI API dahil naka-TEST MODE tayo.\n\n` +
      `Remaining requests: ${rateLimit.remaining}`,

    remaining:
      rateLimit.remaining,

    testMode:
      true
  });
}

    // ------------------------------------
    // REAL AIWOLF REQUEST
    // ------------------------------------

    const input = [
  {
    role: "system",
    content: AIWOLF_INSTRUCTIONS
  },

  {
    role: "user",
    content:
      `CHAPTER:\n${chapter || "Unknown"}\n\n` +
      `MODE:\n${selectedMode}\n\n` +
      `CHAPTER TEXT:\n` +
      `${chapterText}`
  }
];

// ------------------------------------
// PREVIOUS CONVERSATION HISTORY
// ------------------------------------

for (const item of conversationHistory) {

  input.push({
    role: "user",
    content:
      `READER:\n${item.question}`
  });

  input.push({
    role: "assistant",
    content:
      `AIWOLF:\n${item.reply}`
  });
}

// ------------------------------------
// CURRENT READER QUESTION
// ------------------------------------

input.push({
  role: "user",
  content:
    `READER QUESTION:\n${question}`
});

    // ------------------------------------
    // OPENAI
    // ------------------------------------

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input
    });

    // ------------------------------------
// TOKEN USAGE
// ------------------------------------

const usage = response.usage || {};

const inputTokens = usage.input_tokens || 0;
const outputTokens = usage.output_tokens || 0;
const totalTokens = usage.total_tokens || 0;

const creditUsage =
  await recordAIWolfUsage(
    inputTokens,
    outputTokens,
    totalTokens
  );
    
await recordUserAIWolfUsage(
  req.firebaseUser.uid,
  inputTokens,
  outputTokens
);
    
// ------------------------------------
// RESPONSE
// ------------------------------------

res.json({
  reply: response.output_text,

  remaining:
    rateLimit.remaining,

  testMode: false,

  usage: {
    inputTokens,
    outputTokens,
    totalTokens
  },

  credits: {
    startingCredits:
      creditUsage.startingCredits,

    currentRequestCost:
      creditUsage.currentRequestCost,

    totalCost:
      creditUsage.totalCost,

    estimatedRemainingCredits:
      creditUsage.estimatedRemainingCredits
  }
});

  } catch (error) {

    console.error("AIWolf error:", error);

    res.status(500).json({
      error: "AIWolf server error.",
      details: error.message
    });

  }
});

// ========================================
// ADMIN — SET USER CREDIT LIMIT
// ========================================


// ========================================
// ADMIN — SET USER CREDIT LIMIT
// ========================================

app.post(
  "/api/admin/users/:uid/credits",
  requireAdmin,
  async (req, res) => {

    try {

      const targetUid =
        req.params.uid;

      const creditLimit =
        Number(
          req.body.creditLimit
        );

      // ------------------------------------
      // VALIDATE CREDIT LIMIT
      // ------------------------------------

      if (
        !Number.isFinite(creditLimit) ||
        creditLimit < 0
      ) {

        return res.status(400).json({
          error:
            "Invalid credit limit."
        });

      }

      // ------------------------------------
      // MAKE SURE FIREBASE ACCOUNT EXISTS
      // ------------------------------------

      await firebaseAuth.getUser(
        targetUid
      );

      const creditRef =
        db
          .collection("users")
          .doc(targetUid);

      const usageRef =
        db
          .collection("_aiwolf")
          .doc("usage");

      // ------------------------------------
      // TRANSACTION
      // ------------------------------------

      const result =
        await db.runTransaction(
          async (transaction) => {

            // IMPORTANT:
            // All reads must happen BEFORE writes.

            const usersSnapshot =
              await transaction.get(
                db.collection("users")
              );

            const usageSnapshot =
              await transaction.get(
                usageRef
              );

            // --------------------------------
            // TARGET USER
            // --------------------------------

            const targetSnapshot =
              usersSnapshot.docs.find(
                doc =>
                  doc.id === targetUid
              );

            const existingData =
              targetSnapshot
                ? (
                    targetSnapshot.data()
                    || {}
                  )
                : {};

            const oldCreditLimit =
              Number(
                existingData.creditLimit || 0
              );

            const usedCredits =
              Number(
                existingData.usedCredits || 0
              );

            // --------------------------------
            // CALCULATE TOTAL ALLOCATED
            // --------------------------------

            let totalAllocatedCredits = 0;

            usersSnapshot.docs.forEach(
              (doc) => {

                const data =
                  doc.data() || {};

                const amount =
                  Number(
                    data.creditLimit || 0
                  );

                if (
                  Number.isFinite(amount) &&
                  amount > 0
                ) {

                  totalAllocatedCredits +=
                    amount;

                }

              }
            );

            // --------------------------------
            // HOW MUCH IS BEING CHANGED?
            // --------------------------------

            const allocationChange =
              creditLimit -
              oldCreditLimit;

            // --------------------------------
            // AVAILABLE BEFORE CHANGE
            // --------------------------------

            const availableBeforeChange =
              Math.max(
                0,
                AIWOLF_STARTING_CREDITS -
                totalAllocatedCredits
              );

            // --------------------------------
            // CHECK CENTRAL POOL
            // --------------------------------

            if (
              allocationChange >
              availableBeforeChange
            ) {

              const usageData =
                usageSnapshot.exists
                  ? (
                      usageSnapshot.data()
                      || {}
                    )
                  : {};

              const actualAIWolfCost =
                Number(
                  usageData.totalCost || 0
                );

              const error =
                new Error(
                  "INSUFFICIENT_AVAILABLE_CREDITS"
                );

              error.code =
                "INSUFFICIENT_AVAILABLE_CREDITS";

              error.availableToAllocate =
                availableBeforeChange;

              error.requestedAdditionalCredits =
                allocationChange;

              error.totalAllocatedCredits =
                totalAllocatedCredits;

              error.actualAIWolfCost =
                actualAIWolfCost;

              throw error;

            }

            // --------------------------------
            // NEW TOTAL ALLOCATION
            // --------------------------------

            const newTotalAllocatedCredits =
              totalAllocatedCredits +
              allocationChange;

            const finalAvailableToAllocate =
              Math.max(
                0,
                AIWOLF_STARTING_CREDITS -
                newTotalAllocatedCredits
              );

            const now =
              new Date().toISOString();

            // --------------------------------
            // SAVE USER CREDIT LIMIT
            // --------------------------------
            //
            // IMPORTANT:
            // usedCredits is NOT reset.
            //
            // It represents actual AIWolf
            // usage already consumed by this
            // account.

            transaction.set(
              creditRef,
              {

                creditLimit,

                usedCredits,

                updatedAt:
                  now,

                updatedBy:
                  req.firebaseUser.uid

              },
              {
                merge: true
              }
            );

            // --------------------------------
            // UPDATE CENTRAL LEDGER
            // --------------------------------
            //
            // Actual AIWolf Cost is NOT
            // subtracted from AvailableToAllocate.
            //
            // Allocation and actual OpenAI
            // spending are separate metrics.

            const usageData =
              usageSnapshot.exists
                ? (
                    usageSnapshot.data()
                    || {}
                  )
                : {};

            transaction.set(
              usageRef,
              {

                startingCredits:
                  AIWOLF_STARTING_CREDITS,

                totalAllocatedCredits:
                  newTotalAllocatedCredits,

                availableToAllocate:
                  finalAvailableToAllocate,

                totalCost:
                  Number(
                    usageData.totalCost || 0
                  ),

                updatedAt:
                  now

              },
              {
                merge: true
              }
            );

            // --------------------------------
            // RETURN RESULT
            // --------------------------------

            return {

              previousCreditLimit:
                oldCreditLimit,

              usedCredits,

              allocationChange,

              totalAllocatedCredits:
                newTotalAllocatedCredits,

              availableToAllocate:
                finalAvailableToAllocate,

              actualAIWolfCost:
                Number(
                  usageData.totalCost || 0
                )

            };

          }
        );

      // ------------------------------------
      // SUCCESS RESPONSE
      // ------------------------------------

      return res.json({

        ok: true,

        uid:
          targetUid,

        creditLimit,

        usedCredits:
          result.usedCredits,

        previousCreditLimit:
          result.previousCreditLimit,

        allocationChange:
          result.allocationChange,

        totalAllocatedCredits:
          result.totalAllocatedCredits,

        availableToAllocate:
          result.availableToAllocate,

        actualAIWolfCost:
          result.actualAIWolfCost,

        remainingCredits:
          Math.max(
            0,
            creditLimit -
            result.usedCredits
          )

      });

    } catch (error) {

      // ------------------------------------
      // CENTRAL POOL ERROR
      // ------------------------------------

      if (
        error &&
        error.code ===
          "INSUFFICIENT_AVAILABLE_CREDITS"
      ) {

        return res.status(400).json({

          error:
            "Not enough AIWolf credits available to allocate.",

          message:
            "Hindi sapat ang AvailableToAllocate para sa bagong allocation.",

          availableToAllocate:
            error.availableToAllocate,

          requestedAdditionalCredits:
            error.requestedAdditionalCredits,

          totalAllocatedCredits:
            error.totalAllocatedCredits,

          actualAIWolfCost:
            error.actualAIWolfCost

        });

      }

      // ------------------------------------
      // OTHER ERROR
      // ------------------------------------

      console.error(
        "Admin set credits error:",
        error
      );

      return res.status(500).json({

        error:
          "Could not update credit limit."

      });

    }

  }
);

// ========================================
// OLD CHAT ENDPOINT
// ========================================

app.post("/chat", async (req, res) => {

  try {

    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({
        error: "Message is required."
      });
    }

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: message
    });

    res.json({
      reply: response.output_text
    });

  } catch (error) {

    console.error("Chat error:", error);

    res.status(500).json({
      error: "Chat server error.",
      details: error.message
    });

  }

});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {

  console.log(
    `AIWolf server running on port ${PORT}`
  );

  console.log(
    `AIWolf TEST MODE: ${AIWOLF_TEST_MODE}`
  );

  console.log(
    `AIWolf limit: ${AIWOLF_LIMIT} requests / 10 minutes`
  );

  console.log("Firebase Admin: connected");
});
