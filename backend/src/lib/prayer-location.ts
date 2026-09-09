import { prisma } from "./db.js"
import { resolveCityCoordinates, isValidTimeZone } from "./geo.js"
import type { PrayerConfig } from "@prisma/client"

/**
 * Works out the real point in space and time a venue's prayer times must
 * be calculated for.
 *
 * The rule that matters: coordinates are never invented. Before this
 * existed, a config linked to a Location was calculated at latitude 0,
 * longitude 0 — a spot in the Atlantic, which silently produced prayer
 * times for the wrong place. Every source below is either something a
 * human picked, something the venue PC actually reported, or a lookup of
 * the venue's own city in the dataset the portal's Country → City picker
 * already uses (lib/geo.ts). When none of those resolve, this returns null
 * and the caller says so rather than guessing.
 *
 * Timezone precedence is deliberately separate from coordinates: the
 * Windows PC's own IANA zone (reported each heartbeat) wins, because that
 * is the clock the venue actually lives on, then the Location's zone, then
 * whatever the picker saved on the config.
 */

/** Where the venue's *clock* came from. This is what the portal's pill goes
 * green on: prayer times are only truly "from the venue" when the venue PC
 * told us its own zone. */
export type TimezoneSource = "heartbeat" | "location" | "config"
/** Where the venue's *coordinates* came from. Deliberately separate from
 * the timezone: a venue commonly reports a real timezone with no GPS, and
 * that still counts as a venue-sourced clock. */
export type CoordinatesSource = "agent-gps" | "location-city" | "config"

export interface ResolvedPrayerLocation {
  country: string | null
  city: string | null
  region?: string
  latitude: number
  longitude: number
  timezone: string
  timezoneSource: TimezoneSource
  coordinatesSource: CoordinatesSource
  /** Name of the Music Server whose heartbeat supplied the clock, when one did. */
  serverName?: string
}

/**
 * The server whose heartbeat speaks for this venue: online, and the most
 * recent to have actually reported a usable timezone. Ordering on
 * `reportedLocationAt` rather than `lastHeartbeatAt` matters when several
 * machines share a Location — an old agent that beats constantly but never
 * sends a zone must not outrank one that does.
 */
async function venueServerFor(locationId: string) {
  return prisma.musicServer.findFirst({
    where: { locationId, status: "ONLINE" },
    orderBy: [{ reportedLocationAt: { sort: "desc", nulls: "last" } }],
    select: {
      name: true,
      reportedTimezone: true,
      reportedLatitude: true,
      reportedLongitude: true,
      reportedLocationAt: true,
    },
  })
}

export async function resolvePrayerLocation(config: PrayerConfig): Promise<ResolvedPrayerLocation | null> {
  if (config.linkedLocationId) {
    const location = await prisma.location.findUnique({ where: { id: config.linkedLocationId } })
    if (location) {
      const server = await venueServerFor(location.id)

      // The venue PC's clock first (priority B), then the Location's own zone.
      const fromHeartbeat = isValidTimeZone(server?.reportedTimezone)
      const timezone = fromHeartbeat
        ? server!.reportedTimezone!
        : isValidTimeZone(location.timezone)
          ? location.timezone
          : null
      const timezoneSource: TimezoneSource = fromHeartbeat ? "heartbeat" : "location"
      const serverName = fromHeartbeat ? server!.name : undefined

      // A real GPS fix from the agent beats a city-name lookup.
      if (server?.reportedLatitude != null && server?.reportedLongitude != null && timezone) {
        return {
          country: location.country,
          city: location.city,
          region: location.region,
          latitude: server.reportedLatitude,
          longitude: server.reportedLongitude,
          timezone,
          timezoneSource,
          coordinatesSource: "agent-gps",
          serverName,
        }
      }

      const fromCity = resolveCityCoordinates(location.city, location.country)
      if (fromCity) {
        return {
          country: location.country,
          city: location.city,
          region: location.region,
          latitude: fromCity.latitude,
          longitude: fromCity.longitude,
          // Prefer a zone someone/something asserted for this venue over
          // the dataset's guess for the city.
          timezone: timezone ?? fromCity.timezone,
          timezoneSource: timezone ? timezoneSource : "location",
          coordinatesSource: "location-city",
          serverName,
        }
      }
      // Linked to a location whose city isn't in the dataset: fall through
      // to the config's own saved coordinates rather than returning a point
      // we made up.
    }
  }

  // A manually-picked location: the portal's picker stored real coordinates
  // and a real IANA zone with it.
  if (config.latitude != null && config.longitude != null && isValidTimeZone(config.timezone)) {
    return {
      country: config.country,
      city: config.city,
      latitude: config.latitude,
      longitude: config.longitude,
      timezone: config.timezone,
      timezoneSource: "config",
      coordinatesSource: "config",
    }
  }

  // Last resort before giving up: a saved city/country with no coordinates
  // (e.g. written before the picker resolved them).
  const fromConfigCity = resolveCityCoordinates(config.city, config.country)
  if (fromConfigCity) {
    return {
      country: config.country,
      city: config.city,
      latitude: fromConfigCity.latitude,
      longitude: fromConfigCity.longitude,
      timezone: isValidTimeZone(config.timezone) ? config.timezone : fromConfigCity.timezone,
      timezoneSource: "config",
      coordinatesSource: "config",
    }
  }

  return null
}
