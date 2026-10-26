// src/agent/schema.ts
const validateArguments = (schema, value, path = "arguments", depth = 0) => {
	if (depth > 12) throw new Error("工具参数嵌套过深。");
	const invalid = () => {
		throw new Error(`工具参数 ${path} 无效。`);
	};
	if (schema.enum && !schema.enum.includes(value)) invalid();
	switch (schema.type) {
		case "object": {
			if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
			const object = value;
			for (const key of schema.required || []) if (!Object.hasOwn(object, key)) invalid();
			for (const [key, entry] of Object.entries(object)) {
				if ([
					"__proto__",
					"constructor",
					"prototype"
				].includes(key)) invalid();
				if (Object.hasOwn(schema.properties || {}, key)) validateArguments(schema.properties[key], entry, `${path}.${key}`, depth + 1);
				else if (schema.additionalProperties !== true) invalid();
			}
			break;
		}
		case "array":
			if (!Array.isArray(value) || value.length > (schema.maxItems ?? 100)) invalid();
			for (const item of value) if (schema.items) validateArguments(schema.items, item, `${path}[]`, depth + 1);
			break;
		case "string":
			if (typeof value !== "string" || Array.from(value).length < (schema.minLength ?? 0) || Array.from(value).length > (schema.maxLength ?? 16e3)) invalid();
			break;
		case "number":
		case "integer":
			if (typeof value !== "number" || !Number.isFinite(value) || schema.type === "integer" && !Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid();
			break;
		case "boolean":
			if (typeof value !== "boolean") invalid();
			break;
		default: invalid();
	}
};

export { validateArguments };