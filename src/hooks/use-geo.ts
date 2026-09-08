"use client"

import { useQuery } from "@tanstack/react-query"
import { geoApi } from "@/lib/api/geo"

export function useCountries() {
  return useQuery({ queryKey: ["geo-countries"], queryFn: () => geoApi.listCountries(), staleTime: Infinity })
}

export function useCitiesForCountry(country: string | undefined) {
  return useQuery({
    queryKey: ["geo-cities", country],
    queryFn: () => geoApi.listCitiesForCountry(country!),
    enabled: !!country,
    staleTime: Infinity,
  })
}
