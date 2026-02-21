# Security Policy

## Reporting a Vulnerability

Please do not open public GitHub issues for security vulnerabilities.

Report privately to the maintainers with:

- A description of the issue
- Reproduction steps or proof-of-concept
- Impact assessment
- Suggested mitigation (if available)

Until a dedicated security contact is published, open a private GitHub security advisory in this repository.

## Scope

Security-sensitive areas in this project include:

- Worker auth and JWT verification
- Header trust boundary between Worker and Durable Object
- Authorization/permission evaluation
- Data isolation assumptions and routing behavior
