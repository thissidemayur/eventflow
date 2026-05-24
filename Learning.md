1. LOCALHOST != DOCKER NETWORK

Inside Docker:

service name = hostname

Outside Docker:

localhost required

You mixed both worlds.

Classic beginner mistake.

1. MONOREPO DEPENDENCY OWNERSHIP

Wrong mindset:

root has package installed so all packages have it

Wrong.

Correct mindset:

package that imports dependency owns dependency

Critical monorepo principle.

1. BUILD OUTPUT CAN BE STALE

You fixed TS source.

But runtime still used:

dist/
compiled JS

Meaning:

source fixed
build stale

Very common TypeScript problem.

1. RUNTIME ERRORS ARE DIFFERENT FROM BUILD ERRORS

Build succeeded.

Runtime exploded.

Why?

Because:

TypeScript compilation only checks types/syntax
NOT actual runtime module availability

Very important engineering lesson.

1. ZOD API KNOWLEDGE

Wrong:

z.uuid()

Correct:

z.string().uuid()

This tells interviewer:

you understand schema chaining
validator composition
runtime validation systems