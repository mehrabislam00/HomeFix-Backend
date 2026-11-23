import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import Stripe from "stripe";
import "dotenv/config";
import cors from "cors";
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(
  express.json({
    limit: "8mb",
    verify: (req, res, buffer) => {
      if (req.originalUrl.split("?")[0] === "/webhooks/stripe") {
        req.rawBody = Buffer.from(buffer);
      }
    },
  })
);
app.use(cors());

// MongoDB connection

const client = new MongoClient(`mongodb://${process.env.MONGODB_USERNAME}:${process.env.MONGODB_PASSWORD}@ac-asbrkvt-shard-00-00.i2pehxb.mongodb.net:27017,ac-asbrkvt-shard-00-01.i2pehxb.mongodb.net:27017,ac-asbrkvt-shard-00-02.i2pehxb.mongodb.net:27017/?ssl=true&replicaSet=atlas-946ygn-shard-0&authSource=admin`);
export async function connectToMongoDB() {
  await client.connect();
  console.log("You successfully connected to MongoDB!");
  return client;
}

// Connect once at startup
await connectToMongoDB();
const database = client.db("HomeFix_DB");
const userCollection = database.collection("user");
const accountCollection = database.collection("account");
const sessionCollection = database.collection("session");
const customerCollection = database.collection("customers");
const technicianCollection = database.collection("technicians");
const serviceCollection = database.collection("services");
const bookingCollection = database.collection("bookings");
const paymentCollection = database.collection("payments");
const notificationCollection = database.collection("notifications");
const notificationRoles = ["customer", "technician", "admin"];
const notificationTypes = [
  "user_registered",
  "booking_created",
  "booking_updated",
  "booking_cancelled",
  "service_submitted",
  "service_decision",
  "service_removed",
  "account_update",
  "payment_processing",
  "payment_completed",
  "payment_issue",
];

const requireNotificationApiSecret = (req, res) => {
  const secret = process.env.HOMEFIX_PAYMENT_API_SECRET;
  if (!secret) {
    res.status(503).send({ message: "Notification API is not configured" });
    return false;
  }
  if (req.headers["x-homefix-notification-secret"] !== secret) {
    res.status(401).send({ message: "Unauthorized notification request" });
    return false;
  }
  return true;
};
const roleProfiles = {
  customer: {
    collection: customerCollection,
    fields: {},
    removeFields: ["address"],
  },
  technician: {
    collection: technicianCollection,
    fields: {
      skills: [],
      experience: 0,
      serviceCategories: [],
      availability: {},
    },
    removeFields: ["address"],
  },
};

const notifyCompletedPayment = async (booking, paymentId, stripeSessionId, session) => {
  const paymentHref = {
    customer: "/customer-dashboard/payments",
    technician: "/technician-dashboard/payments",
    admin: "/admin-dashboard/transactions",
  };
  const notification = (role) => ({
    type: "payment_completed",
    title: "Payment completed",
    message: `Payment for ${booking.serviceTitle} was verified successfully.`,
    relatedId: paymentId || booking._id.toString(),
    href: paymentHref[role],
    dedupeKey: `payment-completed:${stripeSessionId}`,
  });
  await Promise.all([
    createNotification(
      booking.customerId,
      "customer",
      notification("customer"),
      session
    ),
    createNotification(
      booking.technicianId,
      "technician",
      notification("technician"),
      session
    ),
    notifyAdmins(notification("admin"), session),
  ]);
};

const commonUserDefaults = {
  name: "",
  email: "",
  image: "",
  emailVerified: false,
  role: "",
  phone: "",
  area: "",
  bio: "",
};
const commonUserFields = [...Object.keys(commonUserDefaults), "createdAt", "updatedAt"];

await Promise.all([
  customerCollection.createIndex({ userId: 1 }, { unique: true }),
  technicianCollection.createIndex({ userId: 1 }, { unique: true }),
  paymentCollection.createIndex(
    { bookingId: 1 },
    { unique: true, partialFilterExpression: { bookingId: { $type: "string" } } }
  ),
  paymentCollection.createIndex(
    { stripeSessionId: 1 },
    {
      unique: true,
      partialFilterExpression: { stripeSessionId: { $type: "string" } },
    }
  ),
  paymentCollection.createIndex(
    { transactionId: 1 },
    {
      unique: true,
      partialFilterExpression: { transactionId: { $type: "string" } },
    }
  ),
  paymentCollection.createIndex({ customerEmail: 1, paidAt: -1 }),
  paymentCollection.createIndex({ technicianEmail: 1, paidAt: -1 }),
  paymentCollection.createIndex({ customerId: 1, paidAt: -1 }),
  paymentCollection.createIndex({ technicianId: 1, paidAt: -1 }),
  notificationCollection.createIndex(
    { recipientId: 1, recipientRole: 1, createdAt: -1 },
    { name: "notification_recipient_created" }
  ),
  notificationCollection.createIndex(
    { dedupeKey: 1 },
    {
      name: "notification_dedupe",
      unique: true,
      partialFilterExpression: { dedupeKey: { $type: "string" } },
    }
  ),
]);

const createNotification = async (
  recipientId,
  recipientRole,
  notification,
  session
) => {
  if (!recipientId) return;
  if (!ObjectId.isValid(recipientId)) {
    throw new Error("Cannot create a notification for an invalid recipient ID");
  }
  if (
    !notificationRoles.includes(recipientRole) ||
    !notificationTypes.includes(notification.type)
  ) {
    throw new Error("Cannot create a notification with an invalid role or type");
  }
  const document = {
    recipientId: new ObjectId(recipientId),
    recipientRole,
    title: notification.title,
    message: notification.message,
    type: notification.type,
    ...(notification.relatedId ? { relatedId: notification.relatedId } : {}),
    ...(notification.href ? { href: notification.href } : {}),
    ...(notification.dedupeKey
      ? {
          dedupeKey: `${recipientRole}:${recipientId}:${notification.dedupeKey}`,
        }
      : {}),
    readAt: null,
    createdAt: new Date(),
  };
  const options = session ? { session } : {};
  if (document.dedupeKey) {
    await notificationCollection.updateOne(
      { dedupeKey: document.dedupeKey },
      { $setOnInsert: document },
      { ...options, upsert: true }
    );
    return;
  }
  await notificationCollection.insertOne(document, options);
};

const notifyAdmins = async (notification, session) => {
  const admins = await userCollection
    .find({ role: "admin" }, session ? { session } : {})
    .project({ _id: 1 })
    .toArray();
  await Promise.all(
    admins.map((admin) =>
      createNotification(
        admin._id.toString(),
        "admin",
        notification,
        session
      )
    )
  );
};

const notifySafely = async (label, work) => {
  try {
    await work();
  } catch (error) {
    console.error(`Unable to create ${label} notification(s):`, error);
  }
};

const notificationHref = (role, bookingId) => {
  if (role === "customer") {
    return `/customer-dashboard/bookings/${encodeURIComponent(bookingId)}`;
  }
  if (role === "technician") {
    return `/technician-dashboard/requests/${encodeURIComponent(bookingId)}`;
  }
  return "/admin-dashboard/all-bookings";
};

const syncRoleProfile = async (user) => {
  const roleProfile = roleProfiles[user.role];
  if (!roleProfile) {
    return;
  }

  const createdAt = user.createdAt ?? new Date();
  const commonUser = Object.fromEntries(
    Object.entries(commonUserDefaults).map(([field, fallback]) => [
      field,
      field === "role" ? user.role : user[field] ?? fallback,
    ])
  );
  commonUser.createdAt = createdAt;
  commonUser.updatedAt = user.updatedAt ?? createdAt;

  const profileFields = Object.fromEntries(
    Object.entries(commonUser).map(([field, value]) => [field, { $literal: value }])
  );
  profileFields.userId = { $literal: user._id };
  for (const [field, fallback] of Object.entries(roleProfile.fields)) {
    profileFields[field] = {
      $ifNull: [`$${field}`, { $literal: user[field] ?? fallback }],
    };
  }
  const profileUpdates = [{ $set: profileFields }];
  if (roleProfile.removeFields) {
    profileUpdates.push({ $unset: roleProfile.removeFields });
  }

  try {
    await roleProfile.collection.updateOne(
      { userId: user._id },
      profileUpdates,
      { upsert: true }
    );
  } catch (error) {
    if (
      error.code !== 11000 ||
      !(await roleProfile.collection.findOne({ userId: user._id }))
    ) {
      throw error;
    }
  }
};

const syncExistingRoleProfiles = async () => {
  const users = userCollection.find({ role: { $in: ["customer", "technician"] } });
  for await (const user of users) {
    await syncRoleProfile(user);
  }
};

const watchUserRegistrations = async () => {
  while (true) {
    let changeStream;
    try {
      changeStream = userCollection.watch([], { fullDocument: "updateLookup" });
      for await (const change of changeStream) {
        if (change.fullDocument) {
          if (
            change.operationType === "insert" &&
            ["customer", "technician"].includes(change.fullDocument.role)
          ) {
            const roleName = change.fullDocument.role;
            await notifySafely("user registration", () =>
              notifyAdmins({
                type: "user_registered",
                title: `New ${roleName} registered`,
                message: `${change.fullDocument.name || "A new user"} joined HomeFix as a ${roleName}.`,
                relatedId: change.fullDocument._id.toString(),
                href: "/admin-dashboard/users",
                dedupeKey: `user-registered:${change.fullDocument._id}`,
              })
            );
          }
          await syncRoleProfile(change.fullDocument);
        }
      }
    } catch (error) {
      console.error("User profile synchronization failed:", error);
      try {
        await syncExistingRoleProfiles();
      } catch (syncError) {
        console.error("User profile resynchronization failed:", syncError);
      }
    } finally {
      if (changeStream) {
        try {
          await changeStream.close();
        } catch (error) {
          console.error("Could not close user change stream:", error);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

void watchUserRegistrations();
await syncExistingRoleProfiles();

// Authentication routes
// Better Auth authentication endpoints are managed by the existing auth service.

// User Management routes
const getRoleProfile = async (user, roleProfile) => {
  await syncRoleProfile(user);
  const profile = await roleProfile.collection.findOne({ userId: user._id });
  const commonUser = Object.fromEntries(
    commonUserFields.map((field) => [
      field,
      field === "createdAt" ? user.createdAt : user[field],
    ])
  );
  return {
    ...commonUser,
    ...profile,
    _id: user._id,
    userId: user._id,
    profileId: profile._id,
  };
};

const getRoleUsers = async (role) => {
  const roleProfile = roleProfiles[role];
  const users = await userCollection.find({ role }).toArray();
  return Promise.all(users.map((user) => getRoleProfile(user, roleProfile)));
};

const getRoleUser = async (id, role) => {
  const user = await userCollection.findOne({ _id: new ObjectId(id), role });
  return user ? getRoleProfile(user, roleProfiles[role]) : null;
};

const updateRoleUser = async (req, res, role) => {
  const roleProfile = roleProfiles[role];
  const userId = new ObjectId(req.params.id);
  const userUpdates = {};
  const profileUpdates = {};

  for (const field of ["name", "image", "phone", "area", "bio"]) {
    if (req.body[field] !== undefined) {
      userUpdates[field] = req.body[field];
    }
  }
  for (const field of Object.keys(roleProfile.fields)) {
    if (req.body[field] !== undefined) {
      profileUpdates[field] = req.body[field];
    }
  }
  const hasUpdates =
    Object.keys(userUpdates).length > 0 || Object.keys(profileUpdates).length > 0;
  const updatedAt = new Date();
  if (hasUpdates) userUpdates.updatedAt = updatedAt;

  const user = await userCollection.findOne({ _id: userId, role });
  if (!user) {
    return res.send({ matchedCount: 0, modifiedCount: 0 });
  }
  let result = { matchedCount: 1, modifiedCount: 0 };
  if (Object.keys(userUpdates).length > 0) {
    result = await userCollection.updateOne(
      { _id: userId },
      { $set: userUpdates }
    );
  }

  await syncRoleProfile({ ...user, ...userUpdates });
  if (Object.keys(profileUpdates).length > 0) {
    result = await roleProfile.collection.updateOne(
      { userId },
      { $set: { ...profileUpdates, updatedAt } }
    );
  }
  res.send(result);
};

const jwtSecret = process.env.JWT_SECRET;
const jwtLifetime = 15 * 60;
const jwtIssuer = "homefix-backend";
const jwtAudience = "homefix-api";

const createAccessToken = async (user, session) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sid: session._id.toString(),
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user._id.toString())
    .setIssuer(jwtIssuer)
    .setAudience(jwtAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + jwtLifetime)
    .sign(new TextEncoder().encode(jwtSecret));
};

const verifyAccessToken = async (token) => {
  if (!jwtSecret || typeof token !== "string") return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(jwtSecret),
      { algorithms: ["HS256"], issuer: jwtIssuer, audience: jwtAudience }
    );
    if (
      protectedHeader.typ !== "JWT" ||
      typeof payload.sub !== "string" ||
      !ObjectId.isValid(payload.sub) ||
      typeof payload.sid !== "string" ||
      !ObjectId.isValid(payload.sid) ||
      !["customer", "technician", "admin"].includes(payload.role) ||
      !Number.isInteger(payload.iat) ||
      payload.iat > Math.floor(Date.now() / 1000) + 60
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};

const getBetterAuthSession = async (req) => {
  const secret = process.env.BETTER_AUTH_SECRET;
  const cookieHeader = req.headers.cookie;
  if (!secret || typeof cookieHeader !== "string") return null;

  const cookies = new Map(
    cookieHeader.split(";").map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? [part.trim(), ""]
        : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    })
  );
  const signedCookie =
    cookies.get("__Secure-better-auth.session_token") ||
    cookies.get("better-auth.session_token");
  if (!signedCookie) return null;

  let value;
  try {
    value = decodeURIComponent(signedCookie);
  } catch {
    return null;
  }
  const signatureSeparator = value.lastIndexOf(".");
  if (signatureSeparator < 1) return null;
  const sessionToken = value.slice(0, signatureSeparator);
  const suppliedSignature = Buffer.from(value.slice(signatureSeparator + 1), "base64");
  const expectedSignature = createHmac("sha256", secret)
    .update(sessionToken)
    .digest();
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  const session = await sessionCollection.findOne({
    token: sessionToken,
    expiresAt: { $gt: new Date() },
  });
  if (!session) return null;
  const userId = ObjectId.isValid(session.userId)
    ? new ObjectId(session.userId)
    : null;
  if (!userId || !ObjectId.isValid(session._id)) return null;
  const user = await userCollection.findOne({ _id: userId });
  if (!user) return null;
  return { session, user };
};

const authorizeRequest = (req, res, user) => {
  const path = req.path;
  const deny = () => {
    res.status(403).send({ message: "Forbidden" });
    return false;
  };
  const matchesRoleId = (role, id) =>
    user.role === role &&
    ObjectId.isValid(id) &&
    new ObjectId(id).equals(user._id);

  if (path.startsWith("/admin/")) {
    return matchesRoleId("admin", path.split("/")[2]) || deny();
  }
  if (path === "/customers" || path === "/technicians" || path === "/users") {
    return user.role === "admin" || deny();
  }
  if (path.startsWith("/customers/")) {
    const id = path.split("/")[2];
    return matchesRoleId("customer", id) || user.role === "admin" || deny();
  }
  if (path.startsWith("/technicians/")) {
    const id = path.split("/")[2];
    if (path.endsWith("/services") && req.method !== "GET") {
      return matchesRoleId("technician", id) || deny();
    }
    return matchesRoleId("technician", id) || user.role === "admin" || deny();
  }
  if (path === "/users" || path.startsWith("/users/")) {
    const id = path.split("/")[2];
    return (
      user.role === "admin" ||
      (ObjectId.isValid(id) && new ObjectId(id).equals(user._id)) ||
      deny()
    );
  }
  if (path.startsWith("/services/") && req.method !== "GET") {
    return matchesRoleId("technician", req.body.technicianId) || deny();
  }
  if (path === "/bookings" && req.method === "POST") {
    return matchesRoleId("customer", req.body.customerId) || deny();
  }
  if (path.startsWith("/bookings/")) {
    if (req.method === "PATCH" && path.endsWith("/cancel")) {
      return user.role === "customer" || deny();
    }
    if (req.method === "PATCH") {
      const hasCustomerId = req.body.customerId !== undefined;
      const hasTechnicianId = req.body.technicianId !== undefined;
      if (hasCustomerId === hasTechnicianId) return deny();
      return hasCustomerId
        ? matchesRoleId("customer", req.body.customerId) || deny()
        : matchesRoleId("technician", req.body.technicianId) || deny();
    }
  }
  return true;
};

const authenticateRequest = async (req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (
    req.path === "/" ||
    req.path === "/webhooks/stripe" ||
    req.path === "/auth/token" ||
    req.path === "/auth/refresh" ||
    req.path.startsWith("/notifications/") ||
    (req.method === "GET" &&
      (req.path === "/services" ||
        req.path.startsWith("/services/category/") ||
        /^\/services\/[^/]+$/.test(req.path)))
  ) {
    return next();
  }
  const protectedPath = [
    "/admin/",
    "/users",
    "/customers",
    "/technicians",
    "/bookings",
    "/payments",
    "/services/",
    "/auth/logout",
  ].some((prefix) => req.path === prefix.slice(0, -1) || req.path.startsWith(prefix));
  if (!protectedPath) return next();

  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Bearer token required" });
  }
  if (!jwtSecret || jwtSecret.length < 32) {
    return res.status(503).send({ message: "JWT authentication is not configured" });
  }
  const claims = await verifyAccessToken(authorization.slice(7));
  if (!claims) {
    return res.status(401).send({ message: "Invalid or expired access token" });
  }
  const isLogout = req.path === "/auth/logout";
  const [session, user] = await Promise.all([
    sessionCollection.findOne({
      _id: new ObjectId(claims.sid),
      userId: new ObjectId(claims.sub),
      expiresAt: { $gt: new Date() },
    }),
    userCollection.findOne({ _id: new ObjectId(claims.sub) }),
  ]);
  if (!session && !isLogout) {
    return res.status(401).send({ message: "Session expired or revoked" });
  }
  if (!user || (!isLogout && user.banned === true)) {
    return res.status(403).send({ message: "Account is unavailable" });
  }
  if (!isLogout && user.role !== claims.role) {
    return res.status(401).send({ message: "Account permissions changed; sign in again" });
  }
  req.authUser = user;
  req.authSession = session || {
    _id: new ObjectId(claims.sid),
    userId: new ObjectId(claims.sub),
  };
  if (!authorizeRequest(req, res, user)) return;
  next();
};

app.use(authenticateRequest);

const issueAccessToken = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!jwtSecret || jwtSecret.length < 32) {
    return res.status(503).send({ message: "JWT authentication is not configured" });
  }
  if (!process.env.BETTER_AUTH_SECRET) {
    return res.status(503).send({ message: "Better Auth session verification is not configured" });
  }
  const authSession = await getBetterAuthSession(req);
  if (!authSession) {
    return res.status(401).send({ message: "A valid Better Auth session is required" });
  }
  if (authSession.user.banned === true) {
    return res.status(403).send({ message: "Account is unavailable" });
  }
  if (!["customer", "technician", "admin"].includes(authSession.user.role)) {
    return res.status(403).send({ message: "Account role is unavailable" });
  }
  res.send({
    accessToken: await createAccessToken(authSession.user, authSession.session),
    tokenType: "Bearer",
    expiresIn: jwtLifetime,
    user: {
      id: authSession.user._id.toString(),
      name: authSession.user.name,
      email: authSession.user.email,
      role: authSession.user.role,
    },
  });
};

app.post("/auth/token", issueAccessToken);
app.post("/auth/refresh", issueAccessToken);
app.post("/auth/logout", async (req, res) => {
  await sessionCollection.deleteOne({
    _id: req.authSession._id,
    userId: req.authUser._id,
  });
  res.send({ message: "Session revoked" });
});

app.get("/customers", async (req, res) => {
  res.send(await getRoleUsers("customer"));
});
app.get("/customers/:id", async (req, res) => {
  res.send(await getRoleUser(req.params.id, "customer"));
});
app.patch("/customers/:id", (req, res) => updateRoleUser(req, res, "customer"));

app.get("/technicians", async (req, res) => {
  res.send(await getRoleUsers("technician"));
});
app.get("/technicians/:id", async (req, res) => {
  res.send(await getRoleUser(req.params.id, "technician"));
});
app.patch("/technicians/:id", (req, res) => updateRoleUser(req, res, "technician"));

// Existing user-management endpoints
app.get("/users", async (req, res) => {
    const cursor = userCollection.find({});
    const users = await cursor.toArray();
    res.send(users);
  });

//get a single user by id
app.get("/users/:id", async (req, res) => {
    const id = req.params.id;
    const user = await userCollection.findOne({ _id: new ObjectId(id) });
    res.send(user);
  }); 

//update a user by id

app.patch("/users/:id", async (req, res) => {
  const id = req.params.id;
  const updatedUser = req.body;

  if (updatedUser.email !== undefined || updatedUser.role !== undefined) {
    return res.status(400).send({
      message: "Email and role changes must use the authentication management APIs",
    });
  }

  const filter = { _id: new ObjectId(id) };

  const updateDoc = {
    $set: {
      ...(updatedUser.name !== undefined && { name: updatedUser.name }),
      ...(updatedUser.image !== undefined && { image: updatedUser.image }),
      ...(updatedUser.phone !== undefined && { phone: updatedUser.phone }),
      ...(updatedUser.area !== undefined && { area: updatedUser.area }),
      ...(updatedUser.bio !== undefined && { bio: updatedUser.bio }),
      updatedAt: new Date(),
    },
  };

  const result = await userCollection.updateOne(filter, updateDoc);
  const refreshedUser = await userCollection.findOne(filter);
  if (refreshedUser) {
    await syncRoleProfile(refreshedUser);
  }

  res.send(result);
});

// Services routes
const getAccountById = async (id, role) => {
  if (!ObjectId.isValid(id)) {
    return null;
  }
  const account = await userCollection.findOne({ _id: new ObjectId(id), role });
  return account && typeof account.email === "string" && account.email
    ? account
    : null;
};

const getNotificationRecipient = async (role, userId) => {
  if (!notificationRoles.includes(role) || !ObjectId.isValid(userId)) {
    return null;
  }
  return userCollection.findOne({
    _id: new ObjectId(userId),
    role,
  });
};

const serializeNotification = (notification) => ({
  ...notification,
  _id: notification._id.toString(),
  recipientId: notification.recipientId.toString(),
  createdAt: notification.createdAt.toISOString(),
  readAt: notification.readAt?.toISOString() ?? null,
});

app.get("/notifications/:role/:userId", async (req, res) => {
  if (!(await requireNotificationApiSecret(req, res))) return;
  const recipient = await getNotificationRecipient(
    req.params.role,
    req.params.userId
  );
  if (!recipient) {
    return res.status(404).send({ message: "Notification recipient not found" });
  }
  const recipientId = recipient._id;
  const [notifications, unreadCount] = await Promise.all([
    notificationCollection
      .find({ recipientId, recipientRole: req.params.role })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
    notificationCollection.countDocuments({
      recipientId,
      recipientRole: req.params.role,
      readAt: null,
    }),
  ]);
  res.send({
    notifications: notifications.map(serializeNotification),
    unreadCount,
  });
});

app.get("/notifications/:role/:userId/unread-count", async (req, res) => {
  if (!(await requireNotificationApiSecret(req, res))) return;
  const recipient = await getNotificationRecipient(
    req.params.role,
    req.params.userId
  );
  if (!recipient) {
    return res.status(404).send({ message: "Notification recipient not found" });
  }
  const unreadCount = await notificationCollection.countDocuments({
    recipientId: recipient._id,
    recipientRole: req.params.role,
    readAt: null,
  });
  res.send({ unreadCount });
});

app.patch("/notifications/:role/:userId/read-all", async (req, res) => {
  if (!(await requireNotificationApiSecret(req, res))) return;
  const recipient = await getNotificationRecipient(
    req.params.role,
    req.params.userId
  );
  if (!recipient) {
    return res.status(404).send({ message: "Notification recipient not found" });
  }
  const result = await notificationCollection.updateMany(
    {
      recipientId: recipient._id,
      recipientRole: req.params.role,
      readAt: null,
    },
    { $set: { readAt: new Date() } }
  );
  res.send({ updatedCount: result.modifiedCount });
});

app.patch(
  "/notifications/:role/:userId/:notificationId/read",
  async (req, res) => {
    if (!(await requireNotificationApiSecret(req, res))) return;
    const recipient = await getNotificationRecipient(
      req.params.role,
      req.params.userId
    );
    if (!recipient) {
      return res.status(404).send({ message: "Notification recipient not found" });
    }
    if (!ObjectId.isValid(req.params.notificationId)) {
      return res.status(400).send({ message: "Invalid notification ID" });
    }
    const result = await notificationCollection.updateOne(
      {
        _id: new ObjectId(req.params.notificationId),
        recipientId: recipient._id,
        recipientRole: req.params.role,
      },
      { $set: { readAt: new Date() } }
    );
    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Notification not found" });
    }
    res.send({ ok: true });
  }
);

app.delete("/notifications/:role/:userId/:notificationId", async (req, res) => {
  if (!(await requireNotificationApiSecret(req, res))) return;
  const recipient = await getNotificationRecipient(
    req.params.role,
    req.params.userId
  );
  if (!recipient) {
    return res.status(404).send({ message: "Notification recipient not found" });
  }
  if (!ObjectId.isValid(req.params.notificationId)) {
    return res.status(400).send({ message: "Invalid notification ID" });
  }
  const result = await notificationCollection.deleteOne({
    _id: new ObjectId(req.params.notificationId),
    recipientId: recipient._id,
    recipientRole: req.params.role,
  });
  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Notification not found" });
  }
  res.send({ ok: true });
});

const getPaymentOwnerFilter = (userId, idField, emailField, email) => ({
  $or: [
    { [idField]: userId },
    { [idField]: { $exists: false }, [emailField]: email },
  ],
});

const serviceFields = [
  "title",
  "category",
  "description",
  "image",
  "availability",
  "basePrice",
  "estimatedDuration",
  "serviceMode",
  "serviceArea",
];
const serviceStringFields = serviceFields.filter((field) => field !== "basePrice");
const hasInvalidServiceString = (fields) =>
  serviceStringFields.some(
    (field) => fields[field] !== undefined && typeof fields[field] !== "string"
  );
const approvalStatuses = ["pending", "approved", "rejected"];
const bookingStatuses = [
  "requested",
  "accepted",
  "rejected",
  "in-progress",
  "completed",
  "cancelled",
];
const customerVisibleServices = {
  approvalStatus: "approved",
  isAvailable: true,
};

app.get("/services", async (req, res) => {
  res.send(await serviceCollection.find(customerVisibleServices).toArray());
});

app.get("/services/category/:category", async (req, res) => {
  res.send(
    await serviceCollection
      .find({ ...customerVisibleServices, category: req.params.category })
      .toArray()
  );
});

app.get("/services/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const service = await serviceCollection.findOne({
    _id: new ObjectId(req.params.id),
    ...customerVisibleServices,
  });
  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }
  res.send(service);
});

app.get("/technicians/:id/services", async (req, res) => {
  const technician = await getAccountById(req.params.id, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  res.send(
    await serviceCollection
      .find({ technicianEmail: technician.email })
      .toArray()
  );
});

app.post("/technicians/:id/services", async (req, res) => {
  const technician = await getAccountById(req.params.id, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  if (
    typeof req.body.basePrice !== "number" ||
    !Number.isFinite(req.body.basePrice) ||
    req.body.basePrice < 0
  ) {
    return res.status(400).send({ message: "basePrice must be a non-negative number" });
  }
  if (hasInvalidServiceString(req.body)) {
    return res.status(400).send({ message: "Service text fields must be strings" });
  }
  if (
    req.body.isAvailable !== undefined &&
    typeof req.body.isAvailable !== "boolean"
  ) {
    return res.status(400).send({ message: "isAvailable must be a boolean" });
  }
  const service = Object.fromEntries(
    serviceFields
      .filter((field) => req.body[field] !== undefined)
      .map((field) => [field, req.body[field]])
  );
  service.basePrice = req.body.basePrice;
  service.technicianName =
    typeof technician.name === "string" ? technician.name : "";
  service.technicianEmail = technician.email;
  service.approvalStatus = "pending";
  service.isAvailable = req.body.isAvailable ?? true;
  service.createdAt = new Date();

  const result = await serviceCollection.insertOne(service);
  await notifySafely("service submission", () =>
    notifyAdmins({
      type: "service_submitted",
      title: "Service submitted for approval",
      message: `${service.title || "A service"} was submitted by ${service.technicianName || "a technician"}.`,
      relatedId: result.insertedId.toString(),
      href: "/admin-dashboard/approvals",
      dedupeKey: `service-submitted:${result.insertedId}`,
    })
  );
  res.status(201).send({ ...service, _id: result.insertedId });
});

app.patch("/services/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const technician = await getAccountById(req.body.technicianId, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  const filter = {
    _id: new ObjectId(req.params.id),
    technicianEmail: technician.email,
  };
  const service = await serviceCollection.findOne(filter);
  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }

  const updates = Object.fromEntries(
    serviceFields
      .filter((field) => req.body[field] !== undefined)
      .map((field) => [field, req.body[field]])
  );
  if (hasInvalidServiceString(req.body)) {
    return res.status(400).send({ message: "Service text fields must be strings" });
  }
  if (
    req.body.basePrice !== undefined &&
    (typeof req.body.basePrice !== "number" ||
      !Number.isFinite(req.body.basePrice) ||
      req.body.basePrice < 0)
  ) {
    return res.status(400).send({ message: "basePrice must be a non-negative number" });
  }
  if (
    req.body.approvalStatus !== undefined &&
    !approvalStatuses.includes(req.body.approvalStatus)
  ) {
    return res.status(400).send({ message: "Invalid approvalStatus" });
  }
  if (
    req.body.isAvailable !== undefined &&
    typeof req.body.isAvailable !== "boolean"
  ) {
    return res.status(400).send({ message: "isAvailable must be a boolean" });
  }
  for (const field of ["approvalStatus", "isAvailable"]) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No service fields to update" });
  }
  const submittedForApproval = serviceFields.some(
    (field) => req.body[field] !== undefined
  );
  if (submittedForApproval) {
    updates.approvalStatus = "pending";
  }
  updates.updatedAt = new Date();

  const result = await serviceCollection.updateOne(filter, { $set: updates });
  if (result.matchedCount === 1 && submittedForApproval) {
    const updatedAt = updates.updatedAt;
    await notifySafely("service update submission", () =>
      notifyAdmins({
        type: "service_submitted",
        title: "Service update needs approval",
        message: `${updates.title || service.title} was updated by ${technician.name || "a technician"} and needs review.`,
        relatedId: req.params.id,
        href: "/admin-dashboard/approvals",
        dedupeKey: `service-update:${req.params.id}:${updatedAt.getTime()}`,
      })
    );
  }
  res.send(result);
});

app.delete("/services/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const technician = await getAccountById(req.body.technicianId, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  const result = await serviceCollection.deleteOne({
    _id: new ObjectId(req.params.id),
    technicianEmail: technician.email,
  });
  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Service not found" });
  }
  res.send(result);
});

// Bookings routes
app.post("/bookings", async (req, res) => {
  const customer = await getAccountById(req.body.customerId, "customer");
  if (!customer) {
    return res.status(404).send({ message: "Customer not found" });
  }
  if (!ObjectId.isValid(req.body.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const service = await serviceCollection.findOne({
    _id: new ObjectId(req.body.serviceId),
    ...customerVisibleServices,
  });
  if (!service) {
    return res.status(404).send({ message: "Available service not found" });
  }
  const preferredDateValue = req.body.preferredDate ?? req.body.date;
  const customerPhone = req.body.customerPhone ?? req.body.phone;
  const problemDescription =
    req.body.problemDescription ?? req.body.notes ?? "";
  if (
    typeof preferredDateValue !== "string" ||
    Number.isNaN(new Date(preferredDateValue).getTime())
  ) {
    return res.status(400).send({ message: "preferredDate must be a valid date" });
  }
  if (typeof req.body.address !== "string" || !req.body.address.trim()) {
    return res.status(400).send({ message: "address is required" });
  }
  if (typeof customerPhone !== "string" || !customerPhone.trim()) {
    return res.status(400).send({ message: "customerPhone is required" });
  }
  if (typeof problemDescription !== "string") {
    return res.status(400).send({ message: "problemDescription must be a string" });
  }

  const technician = service.technicianEmail
    ? await userCollection.findOne({
        email: service.technicianEmail,
        role: "technician",
      })
    : null;
  const createdAt = new Date();
  const booking = {
    customerId: customer._id.toString(),
    customerImage: typeof customer.image === "string" ? customer.image : "",
    customerArea: typeof customer.area === "string" ? customer.area : "",
    serviceId: service._id.toString(),
    serviceTitle: service.title,
    serviceDescription:
      typeof service.description === "string" ? service.description : "",
    serviceImage: service.image,
    category: service.category,
    basePrice: service.basePrice,
    technicianName: service.technicianName,
    technicianImage:
      typeof technician?.image === "string" ? technician.image : "",
    technicianEmail: service.technicianEmail,
    technicianId:
      technician?._id.toString() ?? service.technicianId ?? "",
    technicianPhone:
      typeof technician?.phone === "string"
        ? technician.phone
        : typeof service.technicianPhone === "string"
          ? service.technicianPhone
          : "",
    technicianArea:
      typeof technician?.area === "string"
        ? technician.area
        : typeof service.technicianArea === "string"
          ? service.technicianArea
          : "",
    serviceArea: service.serviceArea ?? "",
    serviceMode: service.serviceMode ?? "",
    estimatedDuration: service.estimatedDuration ?? "",
    customerName: typeof customer.name === "string" ? customer.name : "",
    customerEmail: customer.email,
    customerPhone: customerPhone.trim(),
    address: req.body.address.trim(),
    problemDescription: problemDescription.trim(),
    status: "requested",
    finalAmount: service.basePrice,
    paymentStatus: "unpaid",
    createdAt,
    updatedAt: createdAt,
  };
  booking.preferredDate = new Date(preferredDateValue);

  const result = await bookingCollection.insertOne(booking);
  const bookingId = result.insertedId.toString();
  await notifySafely("booking creation", async () => {
    const notifications = [
      createNotification(booking.customerId, "customer", {
        type: "booking_created",
        title: "Booking request submitted",
        message: `Your request for ${booking.serviceTitle} was sent successfully.`,
        relatedId: bookingId,
        href: notificationHref("customer", bookingId),
        dedupeKey: `booking-created:${bookingId}`,
      }),
      createNotification(booking.technicianId, "technician", {
        type: "booking_created",
        title: "New booking request",
        message: `${booking.customerName || "A customer"} requested ${booking.serviceTitle}.`,
        relatedId: bookingId,
        href: notificationHref("technician", bookingId),
        dedupeKey: `booking-created:${bookingId}`,
      }),
      notifyAdmins({
        type: "booking_created",
        title: "New booking created",
        message: `${booking.customerName || "A customer"} booked ${booking.serviceTitle}.`,
        relatedId: bookingId,
        href: notificationHref("admin", bookingId),
        dedupeKey: `booking-created:${bookingId}`,
      }),
    ];
    await Promise.all(notifications);
  });
  res.status(201).send({ ...booking, _id: result.insertedId });
});

app.get("/customers/:id/bookings", async (req, res) => {
  const customer = await getAccountById(req.params.id, "customer");
  if (!customer) {
    return res.status(404).send({ message: "Customer not found" });
  }
  res.send(
    await bookingCollection.find({ customerEmail: customer.email }).toArray()
  );
});

app.get("/customers/:id/services", async (req, res) => {
  const customer = await getAccountById(req.params.id, "customer");
  if (!customer) {
    return res.status(404).send({ message: "Customer not found" });
  }
  res.send(
    await bookingCollection.find({ customerEmail: customer.email }).toArray()
  );
});

app.get("/technicians/:id/bookings", async (req, res) => {
  const technician = await getAccountById(req.params.id, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  res.send(
    await bookingCollection
      .find({ technicianEmail: technician.email })
      .toArray()
  );
});

app.get("/customers/:id/bookings/:bookingId", async (req, res) => {
  const customer = await getAccountById(req.params.id, "customer");
  if (!customer) {
    return res.status(404).send({ message: "Customer not found" });
  }
  if (!ObjectId.isValid(req.params.bookingId)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  const booking = await bookingCollection.findOne({
    _id: new ObjectId(req.params.bookingId),
    customerEmail: customer.email,
  });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found" });
  }
  res.send(booking);
});

app.get("/technicians/:id/bookings/:bookingId", async (req, res) => {
  const technician = await getAccountById(req.params.id, "technician");
  if (!technician) {
    return res.status(404).send({ message: "Technician not found" });
  }
  if (!ObjectId.isValid(req.params.bookingId)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  const booking = await bookingCollection.findOne({
    _id: new ObjectId(req.params.bookingId),
    technicianEmail: technician.email,
  });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found" });
  }
  res.send(booking);
});

app.patch("/bookings/:id/cancel", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  const customer = req.authUser;
  const bookingId = new ObjectId(req.params.id);
  const booking = await bookingCollection.findOne({
    _id: bookingId,
    customerEmail: customer.email,
  });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found" });
  }
  if (!["requested", "pending"].includes(booking.status)) {
    return res.status(409).send({
      message:
        booking.status === "accepted" || booking.status === "in-progress"
          ? "This booking was accepted. Contact your technician to request cancellation."
          : "Only pending booking requests can be cancelled.",
    });
  }

  const updatedAt = new Date();
  const result = await bookingCollection.updateOne(
    {
      _id: bookingId,
      customerEmail: customer.email,
      status: { $in: ["requested", "pending"] },
    },
    { $set: { status: "cancelled", updatedAt } }
  );
  if (result.matchedCount !== 1) {
    return res.status(409).send({
      message: "The booking status changed. Refresh and try again.",
    });
  }

  const bookingIdString = bookingId.toString();
  await notifySafely("customer booking cancellation", async () => {
    const notice = {
      type: "booking_cancelled",
      title: "Booking cancelled",
      message: `Your request for ${booking.serviceTitle} was cancelled.`,
      relatedId: bookingIdString,
      dedupeKey: `booking-status:${bookingIdString}:cancelled`,
    };
    await Promise.all([
      createNotification(booking.customerId, "customer", {
        ...notice,
        href: notificationHref("customer", bookingIdString),
      }),
      createNotification(booking.technicianId, "technician", {
        ...notice,
        title: "Customer cancelled a booking",
        message: `${booking.customerName || "A customer"} cancelled ${booking.serviceTitle}.`,
        href: notificationHref("technician", bookingIdString),
      }),
      notifyAdmins({
        ...notice,
        title: "Booking cancelled",
        message: `${booking.customerName || "A customer"} cancelled ${booking.serviceTitle}.`,
        href: notificationHref("admin", bookingIdString),
      }),
    ]);
  });
  res.send(await bookingCollection.findOne({ _id: bookingId }));
});

app.patch("/bookings/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  if (!bookingStatuses.includes(req.body.status)) {
    return res.status(400).send({ message: "Invalid booking status" });
  }

  const bookingId = new ObjectId(req.params.id);
  let booking;
  let technicianUpdate = false;
  let account;
  if (req.body.technicianId !== undefined) {
    account = await getAccountById(req.body.technicianId, "technician");
    if (!account) {
      return res.status(404).send({ message: "Technician not found" });
    }
    booking = await bookingCollection.findOne({
      _id: bookingId,
      technicianEmail: account.email,
    });
    technicianUpdate = true;
  } else if (req.body.customerId !== undefined) {
    account = req.authUser;
    if (!account) {
      return res.status(404).send({ message: "Customer not found" });
    }
    booking = await bookingCollection.findOne({
      _id: bookingId,
      customerEmail: account.email,
    });
  } else {
    return res.status(400).send({ message: "technicianId or customerId is required" });
  }
  if (!booking) {
    return res.status(404).send({ message: "Booking not found" });
  }

  const transitions = technicianUpdate
    ? {
        requested: ["accepted", "rejected"],
        pending: ["accepted", "rejected"],
        accepted: ["in-progress"],
        "in-progress": ["completed"],
      }
    : {
        requested: ["cancelled"],
        pending: ["cancelled"],
      };
  if (!(transitions[booking.status] || []).includes(req.body.status)) {
    return res.status(400).send({ message: "Invalid booking status transition" });
  }

  const updates = { status: req.body.status };
  if (req.body.status === "in-progress") {
    updates.jobStartedAt = booking.jobStartedAt ?? new Date();
  }
  if (req.body.status === "completed") {
    const finalAmount = req.body.finalAmount ?? booking.basePrice;
    if (
      typeof finalAmount !== "number" ||
      !Number.isFinite(finalAmount) ||
      finalAmount < 0
    ) {
      return res.status(400).send({ message: "finalAmount must be a non-negative number" });
    }
    updates.finalAmount = finalAmount;
    updates.jobCompletedAt = new Date();
  }
  updates.updatedAt = new Date();
  const ownershipFilter = technicianUpdate
    ? { technicianEmail: account.email }
    : { customerEmail: account.email };
  const result = await bookingCollection.updateOne(
    { _id: bookingId, status: booking.status, ...ownershipFilter },
    { $set: updates }
  );
  if (result.matchedCount === 0) {
    return res.status(409).send({
      message: "The booking status changed. Refresh and try again.",
    });
  }
  const bookingIdString = bookingId.toString();
  const statusMessages = {
    accepted: {
      title: "Technician accepted your booking",
      message: `Your request for ${booking.serviceTitle} was accepted.`,
      type: "booking_updated",
    },
    rejected: {
      title: "Technician declined your booking",
      message: `Your request for ${booking.serviceTitle} was declined.`,
      type: "booking_updated",
    },
    "in-progress": {
      title: "Your service has started",
      message: `The technician started your ${booking.serviceTitle} service.`,
      type: "booking_updated",
    },
    completed: {
      title: "Your service is complete",
      message: `The technician marked ${booking.serviceTitle} as complete.`,
      type: "booking_updated",
    },
    cancelled: {
      title: "Booking cancelled",
      message: `The booking for ${booking.serviceTitle} was cancelled.`,
      type: "booking_cancelled",
    },
  };
  const statusNotification = statusMessages[req.body.status];
  if (statusNotification) {
    await notifySafely("booking status update", async () => {
      const recipients = technicianUpdate
        ? [
            createNotification(booking.customerId, "customer", {
              ...statusNotification,
              relatedId: bookingIdString,
              href: notificationHref("customer", bookingIdString),
              dedupeKey: `booking-status:${bookingIdString}:${req.body.status}`,
            }),
          ]
        : [
            createNotification(booking.technicianId, "technician", {
              ...statusNotification,
              title: "Customer cancelled a booking",
              message: `${booking.customerName || "A customer"} cancelled ${booking.serviceTitle}.`,
              relatedId: bookingIdString,
              href: notificationHref("technician", bookingIdString),
              dedupeKey: `booking-status:${bookingIdString}:${req.body.status}`,
            }),
            createNotification(booking.customerId, "customer", {
              ...statusNotification,
              relatedId: bookingIdString,
              href: notificationHref("customer", bookingIdString),
              dedupeKey: `booking-status:${bookingIdString}:${req.body.status}`,
            }),
            notifyAdmins({
              ...statusNotification,
              title: "Booking cancelled",
              message: `${booking.customerName || "A customer"} cancelled ${booking.serviceTitle}.`,
              relatedId: bookingIdString,
              href: notificationHref("admin", bookingIdString),
              dedupeKey: `booking-status:${bookingIdString}:${req.body.status}`,
            }),
          ];
      await Promise.all(recipients);
    });
  }
  res.send(await bookingCollection.findOne({ _id: bookingId }));
});

// Admin routes
const requireAdmin = async (req, res) => {
  if (!ObjectId.isValid(req.params.adminId)) {
    res.status(403).send({ message: "Admin access required" });
    return false;
  }
  const admin = await userCollection.findOne({
    _id: new ObjectId(req.params.adminId),
    role: "admin",
  });
  if (!admin) {
    res.status(403).send({ message: "Admin access required" });
    return false;
  }
  return true;
};

const isAllowedQueryStatus = (value, allowedValues) =>
  value === undefined || allowedValues.includes(value);

const getAdminUser = async (user) => {
  let profile;
  if (user.role === "customer" || user.role === "technician") {
    const roleProfile = roleProfiles[user.role];
    profile = await roleProfile.collection.findOne({ userId: user._id });
  }
  return {
    ...user,
    ...(profile || {}),
    _id: user._id,
    userId: user._id,
    ...(profile ? { profileId: profile._id } : {}),
  };
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const getAdminUserFilters = (query) => {
  const filter = {};
  if (query.role !== undefined) {
    if (!["customer", "technician", "admin"].includes(query.role)) {
      return null;
    }
    filter.role = query.role;
  }
  if (query.banned !== undefined) {
    if (query.banned !== "true" && query.banned !== "false") {
      return null;
    }
    filter.banned = query.banned === "true";
  }
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length > 100) {
      return null;
    }
    const search = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [
      { name: search },
      { email: search },
      { phone: search },
      { area: search },
    ];
  }
  return filter;
};

const getAdminUserList = async (filter, query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 50));
  const users = await userCollection
    .find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .toArray();
  return {
    users: await Promise.all(users.map((user) => getAdminUser(user))),
    page,
    limit,
    total: await userCollection.countDocuments(filter),
  };
};

const getAdminUserByRole = async (id, role) => {
  if (!ObjectId.isValid(id)) {
    return null;
  }
  const user = await userCollection.findOne({ _id: new ObjectId(id), role });
  return user ? getAdminUser(user) : null;
};

const deleteAdminUser = async (user) => {
  if (user.role === "customer") {
    await customerCollection.deleteOne({ userId: user._id });
  } else if (user.role === "technician") {
    await technicianCollection.deleteOne({ userId: user._id });
    await serviceCollection.deleteMany({ technicianEmail: user.email });
  }
  await Promise.all([
    accountCollection.deleteMany({ userId: user._id }),
    sessionCollection.deleteMany({ userId: user._id }),
  ]);
  return userCollection.deleteOne({ _id: user._id });
};

const getBookingDateFilter = (query, filter) => {
  if (query.from === undefined && query.to === undefined) {
    return true;
  }
  const dateFilter = {};
  if (query.from !== undefined) {
    const from = new Date(query.from);
    if (Number.isNaN(from.getTime())) return false;
    dateFilter.$gte = from;
  }
  if (query.to !== undefined) {
    const to = new Date(query.to);
    if (Number.isNaN(to.getTime())) return false;
    dateFilter.$lte = to;
  }
  filter.preferredDate = dateFilter;
  return true;
};

const resolveAdminAccountFilter = async (id, role, field, filter) => {
  if (id === undefined) return true;
  if (!ObjectId.isValid(id)) return false;
  const account = await userCollection.findOne({
    _id: new ObjectId(id),
    role,
  });
  if (!account) return false;
  filter[field] = account.email;
  return true;
};

app.get("/admin/:adminId/dashboard", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const [totalUsers, customers, technicians, bannedUsers, totalServices,
    servicesByApproval, totalBookings, bookingsByStatus] = await Promise.all([
    userCollection.countDocuments({}),
    userCollection.countDocuments({ role: "customer" }),
    userCollection.countDocuments({ role: "technician" }),
    userCollection.countDocuments({ banned: true }),
    serviceCollection.countDocuments({}),
    serviceCollection.aggregate([
      { $group: { _id: "$approvalStatus", count: { $sum: 1 } } },
    ]).toArray(),
    bookingCollection.countDocuments({}),
    bookingCollection.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const serviceStatusCounts = Object.fromEntries(
    servicesByApproval.map(({ _id, count }) => [_id || "unknown", count])
  );
  const bookingStatusCounts = Object.fromEntries(
    bookingsByStatus.map(({ _id, count }) => [_id || "unknown", count])
  );
  res.send({
    users: {
      total: totalUsers,
      customers,
      technicians,
      active: totalUsers - bannedUsers,
      banned: bannedUsers,
    },
    services: {
      total: totalServices,
      approvalStatuses: serviceStatusCounts,
      pending: serviceStatusCounts.pending || 0,
      approved: serviceStatusCounts.approved || 0,
      rejected: serviceStatusCounts.rejected || 0,
    },
    bookings: {
      total: totalBookings,
      statuses: bookingStatusCounts,
      completed: bookingStatusCounts.completed || 0,
      pending:
        (bookingStatusCounts.requested || 0) +
        (bookingStatusCounts.accepted || 0) +
        (bookingStatusCounts["in-progress"] || 0),
      rejected: bookingStatusCounts.rejected || 0,
      cancelled: bookingStatusCounts.cancelled || 0,
    },
    payments: {
      available: false,
      message: "Payment statistics are available after payment integration.",
    },
  });
});

app.get("/admin/:adminId/users", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const filter = getAdminUserFilters(req.query);
  if (!filter) {
    return res.status(400).send({ message: "Invalid user filter" });
  }
  res.send(await getAdminUserList(filter, req.query));
});

app.get("/admin/:adminId/users/:userId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  const user = await userCollection.findOne({
    _id: new ObjectId(req.params.userId),
  });
  if (!user) return res.status(404).send({ message: "User not found" });
  res.send(await getAdminUser(user));
});

const updateAdminUser = async (req, res, expectedRole) => {
  if (!(await requireAdmin(req, res))) return;
  const userIdValue =
    req.params.userId || req.params.customerId || req.params.technicianId;
  if (!ObjectId.isValid(userIdValue)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  if (req.body.role !== undefined || req.body.email !== undefined) {
    return res.status(400).send({
      message: "Email and role changes must use the authentication management APIs",
    });
  }
  const userId = new ObjectId(userIdValue);
  const user = await userCollection.findOne({
    _id: userId,
    ...(expectedRole ? { role: expectedRole } : {}),
  });
  if (!user) {
    const roleName = expectedRole
      ? `${expectedRole[0].toUpperCase()}${expectedRole.slice(1)}`
      : "User";
    return res.status(404).send({ message: `${roleName} not found` });
  }

  const userUpdates = {};
  const profileUpdates = {};
  for (const field of ["name", "image", "phone", "area", "bio"]) {
    if (req.body[field] !== undefined) {
      if (typeof req.body[field] !== "string") {
        return res.status(400).send({ message: `${field} must be a string` });
      }
      userUpdates[field] = req.body[field];
    }
  }
  if (req.body.banned !== undefined) {
    if (typeof req.body.banned !== "boolean") {
      return res.status(400).send({ message: "banned must be a boolean" });
    }
    userUpdates.banned = req.body.banned;
  }
  if (expectedRole === undefined && req.body.emailVerified !== undefined) {
    if (typeof req.body.emailVerified !== "boolean") {
      return res.status(400).send({ message: "emailVerified must be a boolean" });
    }
    userUpdates.emailVerified = req.body.emailVerified;
  }
  const roleProfile = roleProfiles[user.role];
  if (roleProfile) {
    for (const [field, value] of Object.entries(roleProfile.fields)) {
      if (req.body[field] === undefined) continue;
      if (Array.isArray(value) && !Array.isArray(req.body[field])) {
        return res.status(400).send({ message: `${field} must be an array` });
      }
      if (field === "experience" && typeof req.body[field] !== "number") {
        return res.status(400).send({ message: "experience must be a number" });
      }
      if (
        field === "availability" &&
        (req.body[field] === null ||
          typeof req.body[field] !== "object" ||
          Array.isArray(req.body[field]))
      ) {
        return res.status(400).send({ message: "availability must be an object" });
      }
      profileUpdates[field] = req.body[field];
    }
  }
  if (
    Object.keys(userUpdates).length === 0 &&
    Object.keys(profileUpdates).length === 0
  ) {
    return res.status(400).send({ message: "No user fields to update" });
  }
  if (Object.keys(userUpdates).length > 0) {
    userUpdates.updatedAt = new Date();
    await userCollection.updateOne({ _id: userId }, { $set: userUpdates });
  }
  if (Object.keys(profileUpdates).length > 0) {
    await roleProfile.collection.updateOne(
      { userId },
      { $set: { ...profileUpdates, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  const refreshedUser = await userCollection.findOne({ _id: userId });
  res.send(await getAdminUser(refreshedUser));
};

app.patch("/admin/:adminId/users/:userId", (req, res) =>
  updateAdminUser(req, res)
);

app.patch("/admin/:adminId/users/:userId/ban", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  if (typeof req.body.banned !== "boolean") {
    return res.status(400).send({ message: "banned must be a boolean" });
  }
  const user = await userCollection.findOne({
    _id: new ObjectId(req.params.userId),
  });
  if (!user) {
    return res.status(404).send({ message: "User not found" });
  }
  const updatedAt = new Date();
  const result = await userCollection.updateOne(
    { _id: new ObjectId(req.params.userId) },
    { $set: { banned: req.body.banned, updatedAt } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "User not found" });
  }
  if (user.role === "customer" || user.role === "technician") {
    await notifySafely("account status update", () =>
      createNotification(user._id.toString(), user.role, {
        type: "account_update",
        title: req.body.banned ? "Account suspended" : "Account access restored",
        message: req.body.banned
          ? "Your HomeFix account has been suspended. Contact support if you believe this is a mistake."
          : "Your HomeFix account access has been restored.",
        href:
          user.role === "customer"
            ? "/customer-dashboard/profile"
            : "/technician-dashboard/profile",
        dedupeKey: `account-status:${user._id}:${req.body.banned}:${updatedAt.getTime()}`,
      })
    );
  }
  res.send(result);
});

app.delete("/admin/:adminId/users/:userId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  const user = await userCollection.findOne({
    _id: new ObjectId(req.params.userId),
  });
  if (!user) return res.status(404).send({ message: "User not found" });
  res.send(await deleteAdminUser(user));
});

app.get("/admin/:adminId/users/:userId/activity", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  const user = await userCollection.findOne({
    _id: new ObjectId(req.params.userId),
  });
  if (!user) return res.status(404).send({ message: "User not found" });
  const [bookings, services] = await Promise.all([
    user.role === "customer"
      ? bookingCollection.find({ customerEmail: user.email }).toArray()
      : user.role === "technician"
        ? bookingCollection.find({ technicianEmail: user.email }).toArray()
        : [],
    user.role === "technician"
      ? serviceCollection.find({ technicianEmail: user.email }).toArray()
      : [],
  ]);
  res.send({
    user: await getAdminUser(user),
    services,
    bookings,
    bookingCount: bookings.length,
    completedBookingCount: bookings.filter((booking) => booking.status === "completed").length,
  });
});

app.get("/admin/:adminId/customers", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.send(await getAdminUserList({ role: "customer" }, req.query));
});

app.get("/admin/:adminId/customers/:customerId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const customer = await getAdminUserByRole(req.params.customerId, "customer");
  if (!customer) return res.status(404).send({ message: "Customer not found" });
  const bookings = await bookingCollection
    .find({ customerEmail: customer.email })
    .sort({ preferredDate: -1 })
    .toArray();
  res.send({
    ...customer,
    bookings,
    bookingCount: bookings.length,
    completedBookingCount: bookings.filter((booking) => booking.status === "completed").length,
  });
});

app.patch("/admin/:adminId/customers/:customerId", (req, res) =>
  updateAdminUser(req, res, "customer")
);

app.delete("/admin/:adminId/customers/:customerId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const customer = await getAdminUserByRole(req.params.customerId, "customer");
  if (!customer) return res.status(404).send({ message: "Customer not found" });
  res.send(await deleteAdminUser({ ...customer, role: "customer" }));
});

app.get("/admin/:adminId/customers/:customerId/bookings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const customer = await getAdminUserByRole(req.params.customerId, "customer");
  if (!customer) return res.status(404).send({ message: "Customer not found" });
  res.send(await bookingCollection.find({ customerEmail: customer.email }).toArray());
});

app.get("/admin/:adminId/technicians", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.send(await getAdminUserList({ role: "technician" }, req.query));
});

app.get("/admin/:adminId/technicians/:technicianId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAdminUserByRole(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  const [services, bookings] = await Promise.all([
    serviceCollection.find({ technicianEmail: technician.email }).toArray(),
    bookingCollection.find({ technicianEmail: technician.email }).toArray(),
  ]);
  res.send({
    ...technician,
    services,
    bookings,
    serviceCount: services.length,
    bookingCount: bookings.length,
    completedBookingCount: bookings.filter((booking) => booking.status === "completed").length,
    pendingBookingCount: bookings.filter((booking) =>
      ["requested", "accepted", "in-progress"].includes(booking.status)
    ).length,
    rejectedBookingCount: bookings.filter((booking) => booking.status === "rejected").length,
  });
});

app.patch("/admin/:adminId/technicians/:technicianId", (req, res) =>
  updateAdminUser(req, res, "technician")
);

app.delete("/admin/:adminId/technicians/:technicianId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAdminUserByRole(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  res.send(await deleteAdminUser({ ...technician, role: "technician" }));
});

app.get("/admin/:adminId/technicians/:technicianId/services", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAdminUserByRole(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  res.send(await serviceCollection.find({ technicianEmail: technician.email }).toArray());
});

app.get("/admin/:adminId/technicians/:technicianId/bookings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAdminUserByRole(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  res.send(await bookingCollection.find({ technicianEmail: technician.email }).toArray());
});

app.get("/admin/:adminId/services/pending", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.send(await serviceCollection.find({ approvalStatus: "pending" }).toArray());
});

app.get("/admin/:adminId/services", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!isAllowedQueryStatus(req.query.approvalStatus, approvalStatuses)) {
    return res.status(400).send({ message: "Invalid approvalStatus" });
  }
  const filter = {};
  for (const field of ["category", "approvalStatus"]) {
    if (req.query[field] !== undefined) filter[field] = req.query[field];
  }
  if (req.query.isAvailable !== undefined) {
    if (req.query.isAvailable !== "true" && req.query.isAvailable !== "false") {
      return res.status(400).send({ message: "isAvailable must be true or false" });
    }
    filter.isAvailable = req.query.isAvailable === "true";
  }
  if (
    !(await resolveAdminAccountFilter(
      req.query.technicianId,
      "technician",
      "technicianEmail",
      filter
    ))
  ) {
    return res.status(400).send({ message: "Invalid technicianId" });
  }
  res.send(await serviceCollection.find(filter).sort({ createdAt: -1 }).toArray());
});

app.get("/admin/:adminId/services/:serviceId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const service = await serviceCollection.findOne({
    _id: new ObjectId(req.params.serviceId),
  });
  if (!service) return res.status(404).send({ message: "Service not found" });
  const bookings = await bookingCollection.find({ serviceId: service._id.toString() }).toArray();
  res.send({ ...service, bookings, bookingCount: bookings.length });
});

app.patch("/admin/:adminId/services/:serviceId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const serviceId = new ObjectId(req.params.serviceId);
  const service = await serviceCollection.findOne({ _id: serviceId });
  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }
  const updates = {};
  for (const field of serviceFields) {
    if (req.body[field] !== undefined) {
      if (field === "basePrice") {
        if (
          typeof req.body[field] !== "number" ||
          !Number.isFinite(req.body[field]) ||
          req.body[field] < 0
        ) {
          return res.status(400).send({ message: "basePrice must be a non-negative number" });
        }
      } else if (typeof req.body[field] !== "string") {
        return res.status(400).send({ message: `${field} must be a string` });
      }
      updates[field] = req.body[field];
    }
  }
  if (req.body.approvalStatus !== undefined) {
    if (!approvalStatuses.includes(req.body.approvalStatus)) {
      return res.status(400).send({ message: "Invalid approvalStatus" });
    }
    updates.approvalStatus = req.body.approvalStatus;
  }
  if (req.body.isAvailable !== undefined) {
    if (typeof req.body.isAvailable !== "boolean") {
      return res.status(400).send({ message: "isAvailable must be a boolean" });
    }
    updates.isAvailable = req.body.isAvailable;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No service fields to update" });
  }
  const result = await serviceCollection.updateOne(
    { _id: serviceId },
    { $set: updates }
  );
  if (result.matchedCount !== 1) {
    return res.status(404).send({ message: "Service not found" });
  }
  if (
    (updates.approvalStatus &&
      updates.approvalStatus !== service.approvalStatus) ||
    (updates.isAvailable === false && service.isAvailable !== false)
  ) {
    const technician = await userCollection.findOne({
      email: service.technicianEmail,
      role: "technician",
    });
    if (technician) {
      const decision = updates.approvalStatus;
      const suspended = updates.isAvailable === false;
      await notifySafely("admin service update", () =>
        createNotification(technician._id.toString(), "technician", {
          type: suspended ? "service_removed" : "service_decision",
          title: suspended
            ? "Service suspended"
            : `Service ${decision}`,
          message: suspended
            ? `${service.title || "Your service"} was suspended by the HomeFix admin team.`
            : `${service.title || "Your service"} was ${decision} by the HomeFix admin team.`,
          relatedId: req.params.serviceId,
          href: "/technician-dashboard/my-services",
          dedupeKey: `admin-service-update:${req.params.serviceId}:${decision || "suspended"}:${Date.now()}`,
        })
      );
    }
  }
  res.send(result);
});

app.patch("/admin/:adminId/services/:serviceId/approval", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  if (!approvalStatuses.includes(req.body.approvalStatus)) {
    return res.status(400).send({ message: "Invalid approvalStatus" });
  }
  const serviceId = new ObjectId(req.params.serviceId);
  const service = await serviceCollection.findOne({ _id: serviceId });
  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }
  const updatedAt = new Date();
  const result = await serviceCollection.updateOne(
    { _id: serviceId },
    { $set: { approvalStatus: req.body.approvalStatus, updatedAt } }
  );
  if (
    result.matchedCount === 1 &&
    service.approvalStatus !== req.body.approvalStatus
  ) {
    const technician = await userCollection.findOne({
      email: service.technicianEmail,
      role: "technician",
    });
    if (technician) {
      const decision = req.body.approvalStatus;
      await notifySafely("service approval decision", () =>
        createNotification(technician._id.toString(), "technician", {
          type: "service_decision",
          title: `Service ${decision}`,
          message: `${service.title || "Your service"} was ${decision} by the HomeFix admin team.`,
          relatedId: req.params.serviceId,
          href: "/technician-dashboard/my-services",
          dedupeKey: `service-decision:${req.params.serviceId}:${decision}:${updatedAt.getTime()}`,
        })
      );
    }
  }
  res.send(result);
});

app.delete("/admin/:adminId/services/:serviceId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const serviceId = new ObjectId(req.params.serviceId);
  const service = await serviceCollection.findOne({ _id: serviceId });
  if (!service) {
    return res.status(404).send({ message: "Service not found" });
  }
  const result = await serviceCollection.deleteOne({
    _id: serviceId,
  });
  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Service not found" });
  }
  const technician = await userCollection.findOne({
    email: service.technicianEmail,
    role: "technician",
  });
  if (technician) {
    await notifySafely("service removal", () =>
      createNotification(technician._id.toString(), "technician", {
        type: "service_removed",
        title: "Service removed",
        message: `${service.title || "Your service"} was removed by the HomeFix admin team.`,
        relatedId: req.params.serviceId,
        href: "/technician-dashboard/my-services",
        dedupeKey: `service-removed:${req.params.serviceId}`,
      })
    );
  }
  res.send(result);
});

app.get("/admin/:adminId/bookings", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!isAllowedQueryStatus(req.query.status, bookingStatuses)) {
    return res.status(400).send({ message: "Invalid booking status" });
  }
  const filter = {};
  if (req.query.status !== undefined) filter.status = req.query.status;
  if (!getBookingDateFilter(req.query, filter)) {
    return res.status(400).send({ message: "Invalid booking date range" });
  }
  if (
    !(await resolveAdminAccountFilter(
      req.query.customerId,
      "customer",
      "customerEmail",
      filter
    )) ||
    !(await resolveAdminAccountFilter(
      req.query.technicianId,
      "technician",
      "technicianEmail",
      filter
    ))
  ) {
    return res.status(400).send({ message: "Invalid customerId or technicianId" });
  }
  res.send(await bookingCollection.find(filter).sort({ preferredDate: -1 }).toArray());
});

app.get("/admin/:adminId/bookings/:bookingId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.bookingId)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  const booking = await bookingCollection.findOne({
    _id: new ObjectId(req.params.bookingId),
  });
  if (!booking) return res.status(404).send({ message: "Booking not found" });
  const [customer, technician] = await Promise.all([
    userCollection.findOne({ email: booking.customerEmail, role: "customer" }),
    userCollection.findOne({ email: booking.technicianEmail, role: "technician" }),
  ]);
  res.send({
    ...booking,
    customer: customer ? await getAdminUser(customer) : null,
    technician: technician ? await getAdminUser(technician) : null,
  });
});

app.patch("/admin/:adminId/bookings/:bookingId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.bookingId)) {
    return res.status(400).send({ message: "Invalid booking ID" });
  }
  const bookingId = new ObjectId(req.params.bookingId);
  const booking = await bookingCollection.findOne({ _id: bookingId });
  if (!booking) {
    return res.status(404).send({ message: "Booking not found" });
  }
  const updates = {};
  for (const field of ["customerPhone", "address", "problemDescription"]) {
    if (req.body[field] !== undefined) {
      if (typeof req.body[field] !== "string") {
        return res.status(400).send({ message: `${field} must be a string` });
      }
      updates[field] = req.body[field];
    }
  }
  if (req.body.preferredDate !== undefined) {
    const preferredDate = new Date(req.body.preferredDate);
    if (Number.isNaN(preferredDate.getTime())) {
      return res.status(400).send({ message: "preferredDate must be a valid date" });
    }
    updates.preferredDate = preferredDate;
  }
  if (req.body.status !== undefined) {
    if (!bookingStatuses.includes(req.body.status)) {
      return res.status(400).send({ message: "Invalid booking status" });
    }
    updates.status = req.body.status;
  }
  if (req.body.finalAmount !== undefined) {
    if (
      typeof req.body.finalAmount !== "number" ||
      !Number.isFinite(req.body.finalAmount) ||
      req.body.finalAmount < 0
    ) {
      return res.status(400).send({ message: "finalAmount must be a non-negative number" });
    }
    updates.finalAmount = req.body.finalAmount;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No booking fields to update" });
  }
  const result = await bookingCollection.updateOne(
    { _id: bookingId },
    { $set: updates }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "Booking not found" });
  }
  const bookingIdString = bookingId.toString();
  if (updates.status && updates.status !== booking.status) {
    const cancelled = updates.status === "cancelled";
    await notifySafely("admin booking status update", async () => {
      const notice = {
        type: cancelled ? "booking_cancelled" : "booking_updated",
        title: cancelled ? "Booking cancelled" : "Booking status updated",
        message: cancelled
          ? `The booking for ${booking.serviceTitle} was cancelled by an admin.`
          : `The booking for ${booking.serviceTitle} was updated to ${updates.status}.`,
        relatedId: bookingIdString,
        dedupeKey: `admin-booking-status:${bookingIdString}:${updates.status}`,
      };
      await Promise.all([
        createNotification(booking.customerId, "customer", {
          ...notice,
          href: notificationHref("customer", bookingIdString),
        }),
        createNotification(booking.technicianId, "technician", {
          ...notice,
          href: notificationHref("technician", bookingIdString),
        }),
      ]);
    });
  } else if (Object.keys(updates).length > 0) {
    await notifySafely("booking details update", async () => {
      const notice = {
        type: "booking_updated",
        title: "Booking details updated",
        message: `The details for your ${booking.serviceTitle} booking were updated by an admin.`,
        relatedId: bookingIdString,
        dedupeKey: `admin-booking-details:${bookingIdString}:${Date.now()}`,
      };
      await Promise.all([
        createNotification(booking.customerId, "customer", {
          ...notice,
          href: notificationHref("customer", bookingIdString),
        }),
        createNotification(booking.technicianId, "technician", {
          ...notice,
          href: notificationHref("technician", bookingIdString),
        }),
      ]);
    });
  }
  res.send(result);
});

app.get("/admin/:adminId/reports", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const [technicianBookings, customerBookings, popularServices, categoryServices,
    categoryBookings, bookingStatuses, technicianServices] = await Promise.all([
    bookingCollection.aggregate([
      {
        $group: {
          _id: "$technicianEmail",
          bookingCount: { $sum: 1 },
          completedBookingCount: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
          rejectedBookingCount: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
        },
      },
      { $sort: { bookingCount: -1 } },
      { $limit: 10 },
    ]).toArray(),
    bookingCollection.aggregate([
      {
        $group: {
          _id: "$customerEmail",
          bookingCount: { $sum: 1 },
          completedBookingCount: {
            $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] },
          },
        },
      },
      { $sort: { bookingCount: -1 } },
      { $limit: 10 },
    ]).toArray(),
    bookingCollection.aggregate([
      {
        $group: {
          _id: "$serviceId",
          serviceTitle: { $first: "$serviceTitle" },
          category: { $first: "$category" },
          bookingCount: { $sum: 1 },
        },
      },
      { $sort: { bookingCount: -1 } },
      { $limit: 10 },
    ]).toArray(),
    serviceCollection.aggregate([
      { $group: { _id: "$category", serviceCount: { $sum: 1 } } },
      { $sort: { serviceCount: -1 } },
    ]).toArray(),
    bookingCollection.aggregate([
      { $group: { _id: "$category", bookingCount: { $sum: 1 } } },
      { $sort: { bookingCount: -1 } },
    ]).toArray(),
    bookingCollection.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray(),
    serviceCollection.aggregate([
      {
        $group: {
          _id: "$technicianEmail",
          serviceCount: { $sum: 1 },
        },
      },
      { $sort: { serviceCount: -1 } },
      { $limit: 10 },
    ]).toArray(),
  ]);
  res.send({
    mostActiveTechnicians: technicianBookings,
    mostActiveCustomers: customerBookings,
    mostBookedServices: popularServices,
    technicianServiceCounts: technicianServices,
    categoryServiceCounts: categoryServices,
    categoryBookingCounts: categoryBookings,
    bookingStatuses: Object.fromEntries(
      bookingStatuses.map(({ _id, count }) => [_id || "unknown", count])
    ),
  });
});

const paymentStatuses = ["paid", "pending", "failed", "refunded"];

const getPaymentFilter = async (query) => {
  const filter = {};
  if (query.paymentStatus !== undefined) {
    if (!paymentStatuses.includes(query.paymentStatus)) return null;
    filter.paymentStatus = query.paymentStatus;
  }
  if (query.bookingId !== undefined) {
    if (typeof query.bookingId !== "string" || !query.bookingId) return null;
    filter.bookingId = query.bookingId;
  }
  if (query.search !== undefined) {
    if (typeof query.search !== "string" || query.search.length > 100) return null;
    const search = new RegExp(escapeRegex(query.search), "i");
    filter.$or = [
      { serviceTitle: search },
      { customerName: search },
      { customerEmail: search },
      { technicianName: search },
      { technicianEmail: search },
      { transactionId: search },
      { stripeSessionId: search },
      { bookingId: search },
    ];
  }
  if (query.from !== undefined || query.to !== undefined) {
    const paidAt = {};
    if (query.from !== undefined) {
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) return null;
      paidAt.$gte = from;
    }
    if (query.to !== undefined) {
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) return null;
      paidAt.$lte = to;
    }
    filter.paidAt = paidAt;
  }
  if (query.customerId !== undefined) {
    const customer = await getAccountById(query.customerId, "customer");
    if (!customer) return null;
    filter.$and = [
      ...(filter.$and || []),
      getPaymentOwnerFilter(customer._id.toString(), "customerId", "customerEmail", customer.email),
    ];
  }
  if (query.technicianId !== undefined) {
    const technician = await getAccountById(query.technicianId, "technician");
    if (!technician) return null;
    filter.$and = [
      ...(filter.$and || []),
      getPaymentOwnerFilter(
        technician._id.toString(),
        "technicianId",
        "technicianEmail",
        technician.email
      ),
    ];
  }
  return filter;
};

const getPaymentStatistics = async (filter) => {
  const [total, byStatus] = await Promise.all([
    paymentCollection.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ["$paymentStatus", "paid"] },
                "$amount",
                0,
              ],
            },
          },
        },
      },
    ]).toArray(),
    paymentCollection.aggregate([
      { $match: filter },
      { $group: { _id: "$paymentStatus", count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  return {
    totalPayments: total[0]?.count || 0,
    totalRevenue: total[0]?.revenue || 0,
    currency: "BDT",
    byStatus: Object.fromEntries(
      byStatus.map(({ _id, count }) => [_id || "unknown", count])
    ),
  };
};

const getPaymentDetails = async (payment) => {
  const booking = ObjectId.isValid(payment.bookingId)
    ? await bookingCollection.findOne({ _id: new ObjectId(payment.bookingId) })
    : null;
  return { ...payment, booking: booking || null };
};

const getRolePayments = async (req, res, role, statistics = false) => {
  const account = await getAccountById(req.params.id, role);
  if (!account) {
    return res.status(404).send({
      message: role === "customer" ? "Customer not found" : "Technician not found",
    });
  }
  const idField = role === "customer" ? "customerId" : "technicianId";
  const emailField = role === "customer" ? "customerEmail" : "technicianEmail";
  const filter = getPaymentOwnerFilter(
    account._id.toString(),
    idField,
    emailField,
    account.email
  );
  if (statistics) {
    return res.send(await getPaymentStatistics(filter));
  }
  if (req.params.paymentId) {
    if (!ObjectId.isValid(req.params.paymentId)) {
      return res.status(400).send({ message: "Invalid payment ID" });
    }
    const payment = await paymentCollection.findOne({
      _id: new ObjectId(req.params.paymentId),
      ...filter,
    });
    if (!payment) return res.status(404).send({ message: "Payment not found" });
    return res.send(await getPaymentDetails(payment));
  }
  res.send(await paymentCollection.find(filter).sort({ paidAt: -1 }).toArray());
};

const recordVerifiedStripePayment = async (
  stripe,
  checkoutSession,
  eventCreated
) => {
  if (checkoutSession.payment_status !== "paid") {
    return { paymentRecorded: false };
  }
  const bookingId =
    checkoutSession.metadata?.bookingId || checkoutSession.client_reference_id;
  if (!ObjectId.isValid(bookingId)) {
    throw new Error("Stripe session has no valid booking reference");
  }
  const expectedSessionAmount = checkoutSession.amount_total;
  const expectedCurrency = "bdt";
  const transactionId =
    typeof checkoutSession.payment_intent === "string"
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id;
  if (
    typeof transactionId !== "string" ||
    typeof expectedSessionAmount !== "number" ||
    checkoutSession.currency !== expectedCurrency
  ) {
    throw new Error("Stripe session payment details are incomplete");
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(transactionId, {
    expand: ["latest_charge"],
  });
  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.currency !== expectedCurrency
  ) {
    throw new Error("Stripe payment has not succeeded in BDT");
  }

  const bookingObjectId = new ObjectId(bookingId);
  const databaseSession = client.startSession();
  let alreadyProcessed = false;
  try {
    await databaseSession.withTransaction(async () => {
      alreadyProcessed = false;
      const booking = await bookingCollection.findOne(
        { _id: bookingObjectId },
        { session: databaseSession }
      );
      if (!booking) throw new Error("Referenced booking was not found");
      if (
        typeof booking.finalAmount !== "number" ||
        !Number.isFinite(booking.finalAmount) ||
        booking.finalAmount <= 0
      ) {
        throw new Error("Booking has an invalid final amount");
      }
      const expectedBookingAmount = Math.round(booking.finalAmount * 100);
      if (
        expectedSessionAmount !== expectedBookingAmount ||
        paymentIntent.amount_received !== expectedBookingAmount
      ) {
        throw new Error("Stripe payment amount does not match the booking finalAmount");
      }

      const existingPayment = await paymentCollection.findOne(
        {
          $or: [
            { bookingId: booking._id.toString() },
            { stripeSessionId: checkoutSession.id },
          ],
        },
        { session: databaseSession }
      );
      const paidAt =
        paymentIntent.latest_charge &&
        typeof paymentIntent.latest_charge === "object" &&
        paymentIntent.latest_charge.created
          ? new Date(paymentIntent.latest_charge.created * 1000)
          : new Date(eventCreated * 1000);
      if (existingPayment) {
        if (
          existingPayment.bookingId !== booking._id.toString() ||
          existingPayment.stripeSessionId !== checkoutSession.id ||
          existingPayment.transactionId !== transactionId ||
          existingPayment.amount !== booking.finalAmount
        ) {
          throw new Error("Booking or Stripe session already has a different payment record");
        }
        if (
          booking.paymentStatus === "paid" &&
          booking.stripeSessionId &&
          booking.stripeSessionId !== checkoutSession.id
        ) {
          throw new Error("Booking is already paid by a different Stripe session");
        }
        if (booking.paymentStatus !== "paid") {
          await bookingCollection.updateOne(
            { _id: booking._id },
            {
              $set: {
                paymentStatus: "paid",
                transactionId,
                stripeSessionId: checkoutSession.id,
                paidAt,
              },
            },
            { session: databaseSession }
          );
        }
        await notifyCompletedPayment(
          booking,
          existingPayment._id.toString(),
          checkoutSession.id,
          databaseSession
        );
        alreadyProcessed = true;
        return;
      }
      if (booking.paymentStatus === "paid") {
        throw new Error("Booking is marked paid without a matching payment record");
      }

      const [customer, technician] = await Promise.all([
        getAccountById(booking.customerId, "customer"),
        getAccountById(booking.technicianId, "technician"),
      ]);
      const paymentCustomerName = customer?.name || booking.customerName;
      const paymentCustomerEmail = customer?.email || booking.customerEmail;
      const paymentTechnicianName = technician?.name || booking.technicianName;
      const paymentTechnicianEmail =
        technician?.email || booking.technicianEmail;
      const paymentCustomerId = customer?._id.toString() || booking.customerId;
      const paymentTechnicianId =
        technician?._id.toString() || booking.technicianId;
      if (
        ![
          booking.serviceTitle,
          paymentCustomerName,
          paymentCustomerEmail,
          paymentTechnicianName,
          paymentTechnicianEmail,
          paymentCustomerId,
          paymentTechnicianId,
        ].every((value) => typeof value === "string" && value.trim())
      ) {
        throw new Error("Booking is missing required payment ownership or service details");
      }

      const insertedPayment = await paymentCollection.insertOne(
        {
          bookingId: booking._id.toString(),
          customerId: paymentCustomerId,
          technicianId: paymentTechnicianId,
          serviceTitle: booking.serviceTitle,
          customerName: paymentCustomerName,
          customerEmail: paymentCustomerEmail,
          technicianName: paymentTechnicianName,
          technicianEmail: paymentTechnicianEmail,
          amount: booking.finalAmount,
          currency: expectedCurrency,
          transactionId,
          stripeSessionId: checkoutSession.id,
          paymentStatus: "paid",
          paidAt,
        },
        { session: databaseSession }
      );
      const bookingUpdate = await bookingCollection.updateOne(
        { _id: booking._id, paymentStatus: { $ne: "paid" } },
        {
          $set: {
            paymentStatus: "paid",
            transactionId,
            stripeSessionId: checkoutSession.id,
            paidAt,
          },
        },
        { session: databaseSession }
      );
      if (bookingUpdate.matchedCount !== 1) {
        throw new Error("Booking payment status changed while recording payment");
      }
      await notifyCompletedPayment(
        {
          ...booking,
          customerId: paymentCustomerId,
          technicianId: paymentTechnicianId,
        },
        insertedPayment.insertedId.toString(),
        checkoutSession.id,
        databaseSession
      );
    });
  } finally {
    await databaseSession.endSession();
  }
  return {
    bookingId,
    paymentRecorded: !alreadyProcessed,
  };
};

app.post("/payments/checkout/:sessionId/confirm", async (req, res) => {
  if (req.authUser.role !== "customer") {
    return res.status(403).send({ message: "Customer access required" });
  }
  if (!/^cs_(test|live)_/.test(req.params.sessionId)) {
    return res.status(400).send({ message: "Invalid Stripe checkout session ID" });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(503).send({ message: "Stripe payment verification is not configured" });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const checkoutSession = await stripe.checkout.sessions.retrieve(
      req.params.sessionId,
      { expand: ["payment_intent"] }
    );
    const bookingId =
      checkoutSession.metadata?.bookingId ||
      checkoutSession.client_reference_id;
    if (!ObjectId.isValid(bookingId)) {
      return res.status(404).send({ message: "Booking not found" });
    }
    const booking = await bookingCollection.findOne({
      _id: new ObjectId(bookingId),
      customerEmail: req.authUser.email,
      customerId: req.authUser._id.toString(),
    });
    if (!booking) {
      return res.status(404).send({ message: "Booking not found" });
    }
    if (
      checkoutSession.metadata?.bookingId !== bookingId &&
      checkoutSession.client_reference_id !== bookingId
    ) {
      return res.status(400).send({ message: "Checkout session does not match the booking" });
    }
    if (checkoutSession.status === "expired") {
      return res.send({ status: "expired" });
    }
    if (checkoutSession.payment_status !== "paid") {
      return res.send({ status: "pending" });
    }

    const result = await recordVerifiedStripePayment(
      stripe,
      checkoutSession,
      Math.floor(Date.now() / 1000)
    );
    return res.send({ status: "paid", ...result });
  } catch (error) {
    console.error("Unable to confirm customer checkout:", error.message);
    return res.status(502).send({ message: "Unable to verify Stripe payment" });
  }
});

app.post("/webhooks/stripe", async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe webhook received but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is missing.");
    return res.status(503).send({ message: "Stripe webhook is not configured" });
  }
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || !Buffer.isBuffer(req.rawBody)) {
    return res.status(400).send({ message: "Missing Stripe signature or request body" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error.message);
    return res.status(400).send({ message: "Invalid Stripe webhook signature" });
  }

  if (
    [
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "payment_intent.payment_failed",
    ].includes(event.type)
  ) {
    const checkoutSession = event.data.object;
    const failedBookingId =
      checkoutSession.metadata?.bookingId || checkoutSession.client_reference_id;
    if (ObjectId.isValid(failedBookingId)) {
      const booking = await bookingCollection.findOne({
        _id: new ObjectId(failedBookingId),
      });
      if (booking) {
        const expired = event.type === "checkout.session.expired";
        const notification = (role) => ({
          type: "payment_issue",
          title: expired ? "Payment session expired" : "Payment could not be completed",
          message:
            role === "admin"
              ? `Checkout for ${booking.serviceTitle} ${
                  expired ? "expired before payment" : "failed"
                }.`
              : expired
                ? `The payment session for ${booking.serviceTitle} expired before payment was verified.`
                : `The payment for ${booking.serviceTitle} was not completed. You can try again from your payments page.`,
          relatedId: booking._id.toString(),
          href:
            role === "customer"
              ? "/customer-dashboard/payments"
              : role === "technician"
                ? "/technician-dashboard/payments"
                : "/admin-dashboard/transactions",
          dedupeKey: `payment-issue:${event.id}`,
        });
        try {
          await Promise.all([
            createNotification(
              booking.customerId,
              "customer",
              notification("customer")
            ),
            createNotification(
              booking.technicianId,
              "technician",
              notification("technician")
            ),
            notifyAdmins(notification("admin")),
          ]);
        } catch (error) {
          console.error("Unable to create payment issue notifications:", error);
          return res
            .status(500)
            .send({ message: "Could not create payment issue notifications" });
        }
      }
    }
    console.info(`Acknowledged ${event.type}; no payment record was created.`);
    return res.send({ received: true, paymentRecorded: false });
  }
  if (
    event.type === "checkout.session.completed" &&
    event.data.object.payment_status !== "paid"
  ) {
    const checkoutSession = event.data.object;
    const processingBookingId =
      checkoutSession.metadata?.bookingId || checkoutSession.client_reference_id;
    if (ObjectId.isValid(processingBookingId)) {
      const booking = await bookingCollection.findOne({
        _id: new ObjectId(processingBookingId),
      });
      if (booking) {
        try {
          const notice = (role) => ({
            type: "payment_processing",
            title: "Payment is processing",
            message:
              role === "admin"
                ? `Checkout for ${booking.serviceTitle} is awaiting payment provider verification.`
                : `Your payment for ${booking.serviceTitle} is still being verified by the payment provider.`,
            relatedId: booking._id.toString(),
            href:
              role === "customer"
                ? "/customer-dashboard/payments"
                : role === "technician"
                  ? "/technician-dashboard/payments"
                  : "/admin-dashboard/transactions",
            dedupeKey: `payment-processing:${checkoutSession.id}`,
          });
          await Promise.all([
            createNotification(booking.customerId, "customer", notice("customer")),
            notifyAdmins(notice("admin")),
          ]);
        } catch (error) {
          console.error("Unable to create payment processing notifications:", error);
          return res
            .status(500)
            .send({ message: "Could not create payment processing notifications" });
        }
      }
    }
    return res.send({ received: true, paymentRecorded: false });
  }
  if (
    !["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)
  ) {
    return res.send({ received: true });
  }

  try {
    const checkoutSession = event.data.object;
    if (checkoutSession.payment_status !== "paid") {
      return res.send({ received: true, paymentRecorded: false });
    }
    const bookingId =
      checkoutSession.metadata?.bookingId || checkoutSession.client_reference_id;
    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).send({ message: "Stripe session has no valid booking reference" });
    }
    const expectedSessionAmount = checkoutSession.amount_total;
    const expectedCurrency = "bdt";
    const transactionId =
      typeof checkoutSession.payment_intent === "string"
        ? checkoutSession.payment_intent
        : checkoutSession.payment_intent?.id;
    if (
      typeof transactionId !== "string" ||
      typeof expectedSessionAmount !== "number" ||
      checkoutSession.currency !== expectedCurrency
    ) {
      return res.status(400).send({ message: "Stripe session payment details are incomplete" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(transactionId, {
      expand: ["latest_charge"],
    });
    if (
      paymentIntent.status !== "succeeded" ||
      paymentIntent.currency !== expectedCurrency
    ) {
      return res.status(400).send({ message: "Stripe payment has not succeeded in BDT" });
    }
    const bookingObjectId = new ObjectId(bookingId);
    const databaseSession = client.startSession();
    let alreadyProcessed = false;
    try {
      await databaseSession.withTransaction(async () => {
        alreadyProcessed = false;
        const booking = await bookingCollection.findOne(
          { _id: bookingObjectId },
          { session: databaseSession }
        );
        if (!booking) {
          throw new Error("Referenced booking was not found");
        }
        if (
          typeof booking.finalAmount !== "number" ||
          !Number.isFinite(booking.finalAmount) ||
          booking.finalAmount <= 0
        ) {
          throw new Error("Booking has an invalid final amount");
        }
        const expectedBookingAmount = Math.round(booking.finalAmount * 100);
        if (
          expectedSessionAmount !== expectedBookingAmount ||
          paymentIntent.amount_received !== expectedBookingAmount
        ) {
          throw new Error("Stripe payment amount does not match the booking finalAmount");
        }

        const existingPayment = await paymentCollection.findOne(
          {
            $or: [
              { bookingId: booking._id.toString() },
              { stripeSessionId: checkoutSession.id },
            ],
          },
          { session: databaseSession }
        );
        const paidAt =
          paymentIntent.latest_charge &&
          typeof paymentIntent.latest_charge === "object" &&
          paymentIntent.latest_charge.created
            ? new Date(paymentIntent.latest_charge.created * 1000)
            : new Date(event.created * 1000);
        if (existingPayment) {
          if (
            existingPayment.bookingId !== booking._id.toString() ||
            existingPayment.stripeSessionId !== checkoutSession.id ||
            existingPayment.transactionId !== transactionId ||
            existingPayment.amount !== booking.finalAmount
          ) {
            throw new Error("Booking or Stripe session already has a different payment record");
          }
          if (
            booking.paymentStatus === "paid" &&
            booking.stripeSessionId &&
            booking.stripeSessionId !== checkoutSession.id
          ) {
            throw new Error("Booking is already paid by a different Stripe session");
          }
          if (booking.paymentStatus !== "paid") {
            await bookingCollection.updateOne(
              { _id: booking._id },
              {
                $set: {
                  paymentStatus: "paid",
                  transactionId,
                  stripeSessionId: checkoutSession.id,
                  paidAt,
                },
              },
              { session: databaseSession }
            );
          }
          await notifyCompletedPayment(
            booking,
            existingPayment._id.toString(),
            checkoutSession.id,
            databaseSession
          );
          alreadyProcessed = true;
          return;
        }
        if (booking.paymentStatus === "paid") {
          throw new Error("Booking is marked paid without a matching payment record");
        }

        const [customer, technician] = await Promise.all([
          getAccountById(booking.customerId, "customer"),
          getAccountById(booking.technicianId, "technician"),
        ]);
        const paymentCustomerName = customer?.name || booking.customerName;
        const paymentCustomerEmail = customer?.email || booking.customerEmail;
        const paymentTechnicianName = technician?.name || booking.technicianName;
        const paymentTechnicianEmail = technician?.email || booking.technicianEmail;
        const paymentCustomerId = customer?._id.toString() || booking.customerId;
        const paymentTechnicianId = technician?._id.toString() || booking.technicianId;
        if (
          ![
            booking.serviceTitle,
            paymentCustomerName,
            paymentCustomerEmail,
            paymentTechnicianName,
            paymentTechnicianEmail,
            paymentCustomerId,
            paymentTechnicianId,
          ]
            .every((value) => typeof value === "string" && value.trim())
        ) {
          throw new Error("Booking is missing required payment ownership or service details");
        }

        const insertedPayment = await paymentCollection.insertOne(
          {
            bookingId: booking._id.toString(),
            customerId: paymentCustomerId,
            technicianId: paymentTechnicianId,
            serviceTitle: booking.serviceTitle,
            customerName: paymentCustomerName,
            customerEmail: paymentCustomerEmail,
            technicianName: paymentTechnicianName,
            technicianEmail: paymentTechnicianEmail,
            amount: booking.finalAmount,
            currency: expectedCurrency,
            transactionId,
            stripeSessionId: checkoutSession.id,
            paymentStatus: "paid",
            paidAt,
          },
          { session: databaseSession }
        );
        const bookingUpdate = await bookingCollection.updateOne(
          { _id: booking._id, paymentStatus: { $ne: "paid" } },
          {
            $set: {
              paymentStatus: "paid",
              transactionId,
              stripeSessionId: checkoutSession.id,
              paidAt,
            },
          },
          { session: databaseSession }
        );
        if (bookingUpdate.matchedCount !== 1) {
          throw new Error("Booking payment status changed while recording payment");
        }
        await notifyCompletedPayment(
          {
            ...booking,
            customerId: paymentCustomerId,
            technicianId: paymentTechnicianId,
          },
          insertedPayment.insertedId.toString(),
          checkoutSession.id,
          databaseSession
        );
      });
    } finally {
      await databaseSession.endSession();
    }
    res.send({ received: true, paymentRecorded: !alreadyProcessed });
  } catch (error) {
    if (error.code === 11000) {
      const eventTransactionId =
        typeof event.data.object.payment_intent === "string"
          ? event.data.object.payment_intent
          : event.data.object.payment_intent?.id;
      const existingPayment = await paymentCollection.findOne({
        $or: [
          { stripeSessionId: event.data.object.id },
          { transactionId: eventTransactionId },
        ],
      });
      const eventBookingId =
        event.data.object.metadata?.bookingId ||
        event.data.object.client_reference_id;
      if (
        existingPayment &&
        existingPayment.stripeSessionId === event.data.object.id &&
        existingPayment.bookingId === eventBookingId &&
        existingPayment.transactionId === eventTransactionId
      ) {
        const booking = ObjectId.isValid(eventBookingId)
          ? await bookingCollection.findOne({
              _id: new ObjectId(eventBookingId),
            })
          : null;
        if (booking) {
          await notifySafely("verified payment", () =>
            notifyCompletedPayment(
              booking,
              existingPayment._id.toString(),
              existingPayment.stripeSessionId
            )
          );
        }
        return res.send({ received: true, paymentRecorded: false });
      }
    }
    console.error("Stripe payment webhook processing failed:", error.message);
    return res.status(500).send({ message: "Could not record verified Stripe payment" });
  }
});

app.get("/customers/:id/payments/stats", async (req, res) => {
  await getRolePayments(req, res, "customer", true);
});

app.get("/customers/:id/payments", async (req, res) => {
  await getRolePayments(req, res, "customer");
});

app.get("/customers/:id/payments/:paymentId", async (req, res) => {
  await getRolePayments(req, res, "customer");
});

app.get("/technicians/:id/payments/stats", async (req, res) => {
  await getRolePayments(req, res, "technician", true);
});

app.get("/technicians/:id/payments", async (req, res) => {
  await getRolePayments(req, res, "technician");
});

app.get("/technicians/:id/payments/:paymentId", async (req, res) => {
  await getRolePayments(req, res, "technician");
});

app.get("/admin/:adminId/payments/stats", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const filter = await getPaymentFilter(req.query);
  if (!filter) return res.status(400).send({ message: "Invalid payment filter" });
  res.send(await getPaymentStatistics(filter));
});

app.get("/admin/:adminId/payments/customers/:customerId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const customer = await getAccountById(req.params.customerId, "customer");
  if (!customer) return res.status(404).send({ message: "Customer not found" });
  res.send(
    await paymentCollection
      .find(
        getPaymentOwnerFilter(
          customer._id.toString(),
          "customerId",
          "customerEmail",
          customer.email
        )
      )
      .sort({ paidAt: -1 })
      .toArray()
  );
});

app.get("/admin/:adminId/payments/technicians/:technicianId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAccountById(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  res.send(
    await paymentCollection
      .find(
        getPaymentOwnerFilter(
          technician._id.toString(),
          "technicianId",
          "technicianEmail",
          technician.email
        )
      )
      .sort({ paidAt: -1 })
      .toArray()
  );
});

app.get("/admin/:adminId/payments", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const filter = await getPaymentFilter(req.query);
  if (!filter) return res.status(400).send({ message: "Invalid payment filter" });
  res.send(await paymentCollection.find(filter).sort({ paidAt: -1 }).toArray());
});

app.get("/admin/:adminId/payments/:paymentId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.paymentId)) {
    return res.status(400).send({ message: "Invalid payment ID" });
  }
  const payment = await paymentCollection.findOne({
    _id: new ObjectId(req.params.paymentId),
  });
  if (!payment) return res.status(404).send({ message: "Payment not found" });
  res.send(await getPaymentDetails(payment));
});

// Other routes
// Health check
app.get("/", (req, res) => {
  res.send("Hello World!");
});


// Start the server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error(
      "Stripe payment verification is disabled: configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in the backend environment."
    );
  }
});

export default app;