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

// Other routes
// Health check
app.get("/", (req, res) => {
  res.send("Hello World!");
});


// Start the server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
