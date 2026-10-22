/**
 * Minimal, dependency-free GTFS-Realtime protobuf reader.
 * Only standard fields needed for trip updates/vehicle positions are decoded;
 * unknown fields (including TfNSW extensions) are skipped safely.
 * GTFS-R schema: https://gtfs.org/documentation/realtime/reference/
 */
const decoder = new TextDecoder('utf-8', { fatal: false });

function varint(buffer, offset) {
  let number = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (offset >= buffer.length) throw new Error('Truncated GTFS-Realtime protobuf.');
    const next = buffer[offset++];
    number |= BigInt(next & 0x7f) << shift;
    if (!(next & 0x80)) return [number <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(number) : number, offset];
    shift += 7n;
  }
  throw new Error('Invalid GTFS-Realtime varint.');
}

function* fields(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    let tag;
    [tag, offset] = varint(buffer, offset);
    const number = Math.floor(tag / 8), wire = tag % 8;
    if (!number) throw new Error('Invalid GTFS-Realtime field.');
    let value;
    if (wire === 0) [value, offset] = varint(buffer, offset);
    else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (offset + len > buffer.length) throw new Error('Truncated GTFS-Realtime fixed field.');
      value = buffer.subarray(offset, offset + len);
      offset += len;
    } else if (wire === 2) {
      let len;
      [len, offset] = varint(buffer, offset);
      if (!Number.isSafeInteger(len) || len < 0 || offset + len > buffer.length) throw new Error('Invalid GTFS-Realtime message length.');
      value = buffer.subarray(offset, offset + len);
      offset += len;
    } else throw new Error('Unsupported GTFS-Realtime wire type.');
    yield { number, wire, value };
  }
}
function str(field) { return field.wire === 2 ? decoder.decode(field.value) : ''; }
function signed32(value) { return Number(BigInt.asIntN(32, BigInt(value))); }
function unixIso(s) { return Number.isFinite(s) && s > 0 && s < 25e9 ? new Date(s * 1000).toISOString() : null; }
function tripDescriptor(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.number === 1) result.tripId = str(f);
    if (f.number === 2) result.startTime = str(f);
    if (f.number === 3) result.startDate = str(f);
    if (f.number === 4 && f.wire === 0) result.scheduleRelationship = f.value;
    if (f.number === 5) result.routeId = str(f);
    if (f.number === 6 && f.wire === 0) result.directionId = f.value;
  }
  return result;
}
function vehicleDescriptor(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.number === 1) result.id = str(f);
    if (f.number === 2) result.label = str(f);
  }
  return result;
}
function position(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.wire !== 5) continue;
    if (f.number === 1) result.latitude = f.value.readFloatLE(0);
    if (f.number === 2) result.longitude = f.value.readFloatLE(0);
    if (f.number === 3) result.bearing = f.value.readFloatLE(0);
    if (f.number === 5) result.speedMetresPerSecond = f.value.readFloatLE(0);
  }
  if (!Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) ||
      Math.abs(result.latitude) > 90 || Math.abs(result.longitude) > 180 ||
      (result.latitude === 0 && result.longitude === 0)) return null;
  return result;
}
function vehiclePosition(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.number === 1 && f.wire === 2) result.trip = tripDescriptor(f.value);
    if (f.number === 2 && f.wire === 2) result.position = position(f.value);
    if (f.number === 3 && f.wire === 0) result.currentStopSequence = f.value;
    if (f.number === 4 && f.wire === 0) result.currentStatus = f.value;
    if (f.number === 5 && f.wire === 0) result.timestamp = unixIso(f.value);
    if (f.number === 7 && f.wire === 2) result.stopId = str(f);
    if (f.number === 8 && f.wire === 2) result.vehicle = vehicleDescriptor(f.value);
  }
  return result;
}
function stopTimeEvent(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.number === 1 && f.wire === 0) {
      // int32 delay can be negative, encoded as 2's complement int64.
      result.delaySeconds = signed32(f.value);
    }
    if (f.number === 2 && f.wire === 0) result.time = unixIso(f.value);
  }
  return result;
}
function stopTimeUpdate(buf) {
  const result = {};
  for (const f of fields(buf)) {
    if (f.number === 1 && f.wire === 0) result.stopSequence = f.value;
    if (f.number === 2 && f.wire === 2) result.arrival = stopTimeEvent(f.value);
    if (f.number === 3 && f.wire === 2) result.departure = stopTimeEvent(f.value);
    if (f.number === 4 && f.wire === 2) result.stopId = str(f);
    if (f.number === 5 && f.wire === 0) result.scheduleRelationship = f.value;
  }
  return result;
}
function tripUpdate(buf) {
  const result = { stops: [] };
  for (const f of fields(buf)) {
    if (f.number === 1 && f.wire === 2) result.trip = tripDescriptor(f.value);
    if (f.number === 2 && f.wire === 2) result.stops.push(stopTimeUpdate(f.value));
    if (f.number === 3 && f.wire === 2) result.vehicle = vehicleDescriptor(f.value);
    if (f.number === 4 && f.wire === 0) result.timestamp = unixIso(f.value);
    if (f.number === 5 && f.wire === 0) result.delaySeconds = signed32(f.value);
  }
  return result;
}

/** @param {Buffer|Uint8Array} bytes @param {'vehicle'|'trip'} kind */
export function decodeGtfsFeed(bytes, kind) {
  if (kind !== 'vehicle' && kind !== 'trip') throw new Error('Invalid GTFS-Realtime feed type.');
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const entities = [];
  let feedTimestamp = null;
  for (const f of fields(buffer)) {
    if (f.number === 1 && f.wire === 2) {
      for (const header of fields(f.value)) {
        if (header.number === 3 && header.wire === 0) feedTimestamp = unixIso(header.value);
      }
    }
    if (f.number === 2 && f.wire === 2) {
      let entityId = '', deleted = false, content = null;
      for (const child of fields(f.value)) {
        if (child.number === 1 && child.wire === 2) entityId = str(child);
        if (child.number === 2 && child.wire === 0) deleted = Boolean(child.value);
        if (child.number === (kind === 'trip' ? 3 : 4) && child.wire === 2) {
          content = kind === 'trip' ? tripUpdate(child.value) : vehiclePosition(child.value);
        }
      }
      if (!deleted && content?.trip?.tripId) entities.push({ ...content, entityId });
    }
  }
  return { feedTimestamp, entities };
}
