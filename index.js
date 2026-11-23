import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: "8mb" }));
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
]);

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

  const result = await serviceCollection.updateOne(filter, { $set: updates });
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
    account = await getAccountById(req.body.customerId, "customer");
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
        accepted: ["cancelled"],
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

app.patch("/admin/:adminId/users/:userId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  if (req.body.role !== undefined || req.body.email !== undefined) {
    return res.status(400).send({
      message: "Email and role changes must use the authentication management APIs",
    });
  }
  const userId = new ObjectId(req.params.userId);
  const user = await userCollection.findOne({ _id: userId });
  if (!user) return res.status(404).send({ message: "User not found" });

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
  if (req.body.emailVerified !== undefined) {
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
});

app.patch("/admin/:adminId/users/:userId/ban", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.userId)) {
    return res.status(400).send({ message: "Invalid user ID" });
  }
  if (typeof req.body.banned !== "boolean") {
    return res.status(400).send({ message: "banned must be a boolean" });
  }
  const result = await userCollection.updateOne(
    { _id: new ObjectId(req.params.userId) },
    { $set: { banned: req.body.banned, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "User not found" });
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

app.patch("/admin/:adminId/customers/:customerId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const customer = await getAdminUserByRole(req.params.customerId, "customer");
  if (!customer) return res.status(404).send({ message: "Customer not found" });
  const userId = new ObjectId(customer._id);
  const updates = {};
  for (const field of ["name", "image", "phone", "area", "bio"]) {
    if (req.body[field] !== undefined) {
      if (typeof req.body[field] !== "string") {
        return res.status(400).send({ message: `${field} must be a string` });
      }
      updates[field] = req.body[field];
    }
  }
  if (req.body.banned !== undefined) {
    if (typeof req.body.banned !== "boolean") {
      return res.status(400).send({ message: "banned must be a boolean" });
    }
    updates.banned = req.body.banned;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).send({ message: "No customer fields to update" });
  }
  updates.updatedAt = new Date();
  await userCollection.updateOne({ _id: userId }, { $set: updates });
  const updated = await userCollection.findOne({ _id: userId });
  res.send(await getAdminUser(updated));
});

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

app.patch("/admin/:adminId/technicians/:technicianId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  const technician = await getAdminUserByRole(req.params.technicianId, "technician");
  if (!technician) return res.status(404).send({ message: "Technician not found" });
  const userId = new ObjectId(technician._id);
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
  for (const field of ["skills", "experience", "serviceCategories", "availability"]) {
    if (req.body[field] === undefined) continue;
    if (
      ["skills", "serviceCategories"].includes(field) &&
      !Array.isArray(req.body[field])
    ) {
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
  if (Object.keys(userUpdates).length === 0 && Object.keys(profileUpdates).length === 0) {
    return res.status(400).send({ message: "No technician fields to update" });
  }
  if (Object.keys(userUpdates).length > 0) {
    userUpdates.updatedAt = new Date();
    await userCollection.updateOne({ _id: userId }, { $set: userUpdates });
  }
  if (Object.keys(profileUpdates).length > 0) {
    await technicianCollection.updateOne(
      { userId },
      { $set: { ...profileUpdates, updatedAt: new Date() } },
      { upsert: true }
    );
  }
  res.send(await getAdminUser(await userCollection.findOne({ _id: userId })));
});

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
    { _id: new ObjectId(req.params.serviceId) },
    { $set: updates }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "Service not found" });
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
  const result = await serviceCollection.updateOne(
    { _id: new ObjectId(req.params.serviceId) },
    { $set: { approvalStatus: req.body.approvalStatus } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "Service not found" });
  }
  res.send(result);
});

app.delete("/admin/:adminId/services/:serviceId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  if (!ObjectId.isValid(req.params.serviceId)) {
    return res.status(400).send({ message: "Invalid service ID" });
  }
  const result = await serviceCollection.deleteOne({
    _id: new ObjectId(req.params.serviceId),
  });
  if (result.deletedCount === 0) {
    return res.status(404).send({ message: "Service not found" });
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
    { _id: new ObjectId(req.params.bookingId) },
    { $set: updates }
  );
  if (result.matchedCount === 0) {
    return res.status(404).send({ message: "Booking not found" });
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

app.get("/admin/:adminId/payments", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.status(501).send({
    message: "Payment records are unavailable until payment integration is implemented.",
  });
});

app.get("/admin/:adminId/payments/:paymentId", async (req, res) => {
  if (!(await requireAdmin(req, res))) return;
  res.status(501).send({
    message: "Payment records are unavailable until payment integration is implemented.",
  });
});

// Other routes
// Health check
app.get("/", (req, res) => {
  res.send("Hello World!");
});


// Start the server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
