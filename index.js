import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";
const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(express.json());
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
  if (
    req.body.preferredDate !== undefined &&
    Number.isNaN(new Date(req.body.preferredDate).getTime())
  ) {
    return res.status(400).send({ message: "preferredDate must be a valid date" });
  }
  for (const field of ["customerPhone", "address", "problemDescription"]) {
    if (req.body[field] !== undefined && typeof req.body[field] !== "string") {
      return res.status(400).send({ message: `${field} must be a string` });
    }
  }

  const booking = {
    serviceId: service._id.toString(),
    serviceTitle: service.title,
    serviceImage: service.image,
    category: service.category,
    basePrice: service.basePrice,
    technicianName: service.technicianName,
    technicianEmail: service.technicianEmail,
    customerName: typeof customer.name === "string" ? customer.name : "",
    customerEmail: customer.email,
    customerPhone:
      req.body.customerPhone ??
      (typeof customer.phone === "string" ? customer.phone : ""),
    address: req.body.address ?? "",
    problemDescription: req.body.problemDescription ?? "",
    status: "requested",
    finalAmount: service.basePrice,
    paymentStatus: "unpaid",
  };
  if (req.body.preferredDate !== undefined) {
    booking.preferredDate = new Date(req.body.preferredDate);
  }

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
  }
  const result = await bookingCollection.updateOne(
    { _id: bookingId },
    { $set: updates }
  );
  res.send(result);
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
