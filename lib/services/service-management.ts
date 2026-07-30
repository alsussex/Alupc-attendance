import type { ChurchService } from "@/lib/domain";

export function serviceDisplayName(service: ChurchService) {
  return service.customName || service.serviceType;
}

export function archivedServices(
  services: ChurchService[],
  query = "",
) {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return services
    .filter((service) => service.isArchived && !service.deletedAt)
    .filter((service) => {
      if (terms.length === 0) return true;
      const searchable = [
        serviceDisplayName(service),
        service.serviceType,
        service.serviceDate,
        service.notes,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .sort(
      (a, b) =>
        b.serviceDate.localeCompare(a.serviceDate) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

export function servicesEligibleForBulkArchive(
  services: ChurchService[],
  beforeDate: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) return [];
  return services
    .filter(
      (service) =>
        !service.deletedAt &&
        !service.isArchived &&
        service.status === "completed" &&
        service.serviceDate < beforeDate,
    )
    .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
}
