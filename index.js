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
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

// Connect once at startup
const connectClient = await connectToMongoDB();
const database = client.db("HomeFix_DB");
const userCollection = database.collection("user");

// Authentication routes
// Better Auth authentication endpoints are managed by the existing auth service.

// User Management routes
app.get("/customers", async (req, res) => {
  const customers = await userCollection.find({ role: "customer" }).toArray();
  res.send(customers);
});

app.get("/customers/:id", async (req, res) => {
  const id = req.params.id;
  const customer = await userCollection.findOne({
    _id: new ObjectId(id),
    role: "customer",
  });
  res.send(customer);
});

app.patch("/customers/:id", async (req, res) => {
  const id = req.params.id;
  const updatedCustomer = req.body;

  const result = await userCollection.updateOne(
    { _id: new ObjectId(id), role: "customer" },
    {
      $set: {
        ...(updatedCustomer.name !== undefined && { name: updatedCustomer.name }),
        ...(updatedCustomer.image !== undefined && { image: updatedCustomer.image }),
        ...(updatedCustomer.phone !== undefined && { phone: updatedCustomer.phone }),
        ...(updatedCustomer.area !== undefined && { area: updatedCustomer.area }),
        ...(updatedCustomer.bio !== undefined && { bio: updatedCustomer.bio }),
        ...(updatedCustomer.address !== undefined && { address: updatedCustomer.address }),
      },
    }
  );

  res.send(result);
});

app.get("/technicians", async (req, res) => {
  const technicians = await userCollection.find({ role: "technician" }).toArray();
  res.send(technicians);
});

app.get("/technicians/:id", async (req, res) => {
  const id = req.params.id;
  const technician = await userCollection.findOne({
    _id: new ObjectId(id),
    role: "technician",
  });
  res.send(technician);
});

app.patch("/technicians/:id", async (req, res) => {
  const id = req.params.id;
  const updatedTechnician = req.body;

  const result = await userCollection.updateOne(
    { _id: new ObjectId(id), role: "technician" },
    {
      $set: {
        ...(updatedTechnician.name !== undefined && { name: updatedTechnician.name }),
        ...(updatedTechnician.image !== undefined && { image: updatedTechnician.image }),
        ...(updatedTechnician.phone !== undefined && { phone: updatedTechnician.phone }),
        ...(updatedTechnician.area !== undefined && { area: updatedTechnician.area }),
        ...(updatedTechnician.bio !== undefined && { bio: updatedTechnician.bio }),
        ...(updatedTechnician.skills !== undefined && { skills: updatedTechnician.skills }),
        ...(updatedTechnician.experience !== undefined && { experience: updatedTechnician.experience }),
        ...(updatedTechnician.serviceCategories !== undefined && { serviceCategories: updatedTechnician.serviceCategories }),
        ...(updatedTechnician.availability !== undefined && { availability: updatedTechnician.availability }),
      },
    }
  );

  res.send(result);
});

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
    },
  };

  const result = await userCollection.updateOne(filter, updateDoc);

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
