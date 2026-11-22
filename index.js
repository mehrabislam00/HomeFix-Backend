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


//this is a test route to check if the server is running
app.get("/", (req, res) => {
  res.send("Hello World!");
});


//get all users
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

  const filter = { _id: new ObjectId(id) };

  const updateDoc = {
    $set: {
      ...(updatedUser.name !== undefined && { name: updatedUser.name }),
      ...(updatedUser.email !== undefined && { email: updatedUser.email }),
      ...(updatedUser.image !== undefined && { image: updatedUser.image }),
      ...(updatedUser.role !== undefined && { role: updatedUser.role }),
      ...(updatedUser.phone !== undefined && { phone: updatedUser.phone }),
      ...(updatedUser.area !== undefined && { area: updatedUser.area }),
      ...(updatedUser.bio !== undefined && { bio: updatedUser.bio }),
    },
  };

  const result = await userCollection.updateOne(filter, updateDoc);

  res.send(result);
});



// Start the server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
