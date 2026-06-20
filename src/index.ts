import "dotenv/config";
import express from "express";
import cors from "cors";
import { getEnv } from "./lib/env";

const env = getEnv();
const app = express();

app.use(express.json());
app.use(cors());

app.listen(env.PORT, () =>
  console.log("Eaglespress sever started and listening on port", env.PORT),
);
