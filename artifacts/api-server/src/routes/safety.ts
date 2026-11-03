import { Router, type IRouter } from "express";
import {
  AuthorizeRfidBody,
  AuthorizeRfidResponse,
  GetSafetyEventsResponse,
  GetSafetyStateResponse,
} from "@workspace/api-zod";
import {
  authorizeManualRfid,
  getSafetyEvents,
  getSafetyState,
} from "../lib/safety";

const router: IRouter = Router();

router.get("/safety/state", (_req, res): void => {
  res.json(GetSafetyStateResponse.parse(getSafetyState()));
});

router.get("/safety/events", (_req, res): void => {
  res.json(GetSafetyEventsResponse.parse(getSafetyEvents()));
});

router.post("/safety/authorize-rfid", (req, res): void => {
  const body = AuthorizeRfidBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "A valid RFID code is required" });
    return;
  }
  res.json(
    AuthorizeRfidResponse.parse({
      authorized: authorizeManualRfid(body.data.uid),
    }),
  );
});

export default router;
