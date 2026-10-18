# Licensing decision

The first public beta must not ship without the owner's explicit license decision. The current
working tree contains a candidate `AGPL-3.0-only` license for the platform and MIT licenses for
`@opensend/sdk` and `@opensend/contracts`; do not treat that unmerged state as final approval.

| Option        | Self-hosted users                                                                                                                       | Commercial hosted use                                                                                                    | Managed-cloud implications                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT           | May use, modify and redistribute with attribution and warranty disclaimer.                                                              | A third party can offer a modified hosted service without publishing its changes.                                        | Simplest adoption, weakest protection against proprietary hosted forks.                                                                           |
| Apache-2.0    | Similar permissive use, with an explicit patent grant and notice requirements.                                                          | A third party can offer a modified hosted service without publishing its changes.                                        | Strong enterprise familiarity and patent terms; still permits closed hosted forks.                                                                |
| AGPL-3.0-only | May use, modify and redistribute under strong copyleft terms. Network users of a modified version must be offered corresponding source. | A hosted operator can charge for the service, but modifications offered over a network trigger source-offer obligations. | Best fit for protecting an open self-hosted core while the copyright owner offers a managed service; some companies will avoid AGPL dependencies. |

## Recommendation

For the stated goal—free self-hosted open-source core plus an optional paid managed service—the
recommended default is `AGPL-3.0-only` for the server/platform and MIT for client contracts/SDKs.
This discourages proprietary hosted forks while keeping application integration straightforward.

If future proprietary or partner licensing is planned, decide contribution terms before accepting
outside code. A Developer Certificate of Origin confirms contributor rights but does not by itself
permit relicensing. A contributor license agreement can permit dual licensing but adds contributor
friction and requires a carefully reviewed legal document.

This comparison is practical project guidance, not legal advice. The owner must confirm the choice
before the candidate license files and README claims are merged.
