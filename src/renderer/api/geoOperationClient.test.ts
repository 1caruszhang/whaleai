import { describe, expect, it, vi } from "vitest";

import type { GeoOperationProjection } from "../../shared/geo/operation";
import {
  chooseNextRoundKnowledge,
  confirmGeoOperationStep,
  controlGeoOperation,
  loadGeoOperation,
  loadGeoOperations,
  type GeoOperationApiPost,
} from "./geoOperationClient";

const operation = {
  id: "operation-17",
  revision: 4,
} as GeoOperationProjection;

describe("geoOperationClient", () => {
  it("keeps every read and action on the exact workspace/session/operation revision", async () => {
    const postMock = vi.fn(async (path: string, _body?: unknown) => ({
      success: true,
      ...(path.endsWith("/list") ? { operations: [operation] } : { operation }),
    }));
    const apiPost = postMock as unknown as GeoOperationApiPost;
    const identity = { workspaceId: "brand-17", sessionId: "session-17" };

    await loadGeoOperations(apiPost, identity, { limit: 20 });
    await loadGeoOperation(apiPost, identity, operation.id);
    await controlGeoOperation(apiPost, identity, {
      operationId: operation.id,
      expectedRevision: 4,
      action: "resume",
    });
    await chooseNextRoundKnowledge(apiPost, identity, {
      operationId: operation.id,
      expectedRevision: 4,
      updateKnowledge: false,
    });
    await confirmGeoOperationStep(apiPost, identity, {
      operationId: operation.id,
      expectedRevision: 4,
      stepId: "confirm-question-selection",
      artifactRefs: [{ kind: "question-pool", id: "pool-17", revision: 2 }],
    });

    for (const [, body] of postMock.mock.calls) {
      expect(body).toMatchObject(identity);
    }
    for (const [, body] of postMock.mock.calls.slice(1)) {
      expect(body).toMatchObject({ operationId: operation.id });
    }
    expect(postMock.mock.calls[2]?.[1]).toMatchObject({ expectedRevision: 4 });
    expect(postMock.mock.calls[3]?.[1]).toMatchObject({ expectedRevision: 4 });
    expect(postMock.mock.calls[4]?.[1]).toMatchObject({
      expectedRevision: 4,
      stepId: "confirm-question-selection",
      artifactRefs: [{ kind: "question-pool", id: "pool-17", revision: 2 }],
    });
  });

  it("surfaces a structured route failure", async () => {
    const apiPost = vi.fn(async () => ({
      success: false,
      error: "geo_operation_revision_conflict",
    })) as unknown as GeoOperationApiPost;

    await expect(controlGeoOperation(apiPost, {
      workspaceId: "brand-17",
      sessionId: "session-17",
    }, {
      operationId: "operation-17",
      expectedRevision: 3,
      action: "retry",
    })).rejects.toThrow("geo_operation_revision_conflict");
  });
});
