import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { inngestHandler } from "./inngest/route";
import { getEnv } from "./lib/env";
import { auth } from "./lib/auth";

const env = getEnv();
const app = express();

// REQUIRED for better auth integration must be before express.json().
app.all("/api/auth/*", toNodeHandler(auth));

app.use(express.json());
app.use(cors());

// 👇 REQUIRED endpoint for Inngest
app.use("/api/inngest", inngestHandler);

app.listen(env.PORT, () =>
  console.log("Eaglespress sever started and listening on port", env.PORT),
);
