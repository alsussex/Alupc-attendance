export interface ChildProgramCopy {
  kind: "sunday_school" | "childrens_church";
  label: "Sunday School Kids" | "Children’s Church";
  helperText: string;
}

export function childProgramForService(
  serviceType: string | undefined,
): ChildProgramCopy | null {
  if (
    serviceType === "Sunday Morning" ||
    serviceType === "Special Service"
  ) {
    return {
      kind: "sunday_school",
      label: "Sunday School Kids",
      helperText: "Children attending Sunday School without recorded names.",
    };
  }
  if (serviceType === "Wednesday Bible Study") {
    return {
      kind: "childrens_church",
      label: "Children’s Church",
      helperText:
        "Children attending Children’s Church without recorded names.",
    };
  }
  return null;
}

export function namedVisitorChildProgramForService(
  serviceType: string | undefined,
): ChildProgramCopy | null {
  if (serviceType === "Sunday Morning" || serviceType === "Wednesday Bible Study") {
    return childProgramForService(serviceType);
  }
  return null;
}
