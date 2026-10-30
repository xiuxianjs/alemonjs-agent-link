// src/agent/schema.ts
var ToolArgumentError = class extends Error {
	field;
	reason;
	allowedFields;
	constructor(field, reason, allowedFields) {
		super(reason === "unknown_field" ? `工具参数 ${field} 不在当前工具定义中。` : reason === "required_field" ? `工具参数 ${field} 缺失。` : reason === "nesting_limit" ? "工具参数嵌套过深。" : `工具参数 ${field} 无效。`);
		this.field = field;
		this.reason = reason;
		this.allowedFields = allowedFields;
		this.name = "ToolArgumentError";
	}
};
const fieldName = (key) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) ? key : "[field]";
const fieldPath = (value) => value.replace(/[^A-Za-z0-9_.[\]]/gu, "_").slice(0, 200);
const allowedFields = (schema) => Object.keys(schema.properties || {}).filter((key) => fieldName(key) === key).slice(0, 32);
const validateArguments = (schema, value, path = "arguments", depth = 0) => {
	if (depth > 12) throw new ToolArgumentError(fieldPath(path), "nesting_limit");
	const invalid = () => {
		throw new ToolArgumentError(fieldPath(path), "invalid_value");
	};
	if (schema.enum && !schema.enum.includes(value)) invalid();
	switch (schema.type) {
		case "object": {
			if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
			const object = value;
			for (const key of schema.required || []) if (!Object.hasOwn(object, key)) throw new ToolArgumentError(fieldPath(`${path}.${fieldName(key)}`), "required_field", allowedFields(schema));
			for (const [key, entry] of Object.entries(object)) {
				if ([
					"__proto__",
					"constructor",
					"prototype"
				].includes(key)) invalid();
				if (Object.hasOwn(schema.properties || {}, key)) validateArguments(schema.properties[key], entry, `${path}.${fieldName(key)}`, depth + 1);
				else if (schema.additionalProperties !== true) throw new ToolArgumentError(fieldPath(`${path}.${fieldName(key)}`), "unknown_field", allowedFields(schema));
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

export { ToolArgumentError, validateArguments };