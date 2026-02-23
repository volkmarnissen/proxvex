# Changelog

## [0.2.0](https://github.com/volkmarnissen/oci-lxc-deployer/compare/oci-lxc-deployer-v0.1.22...oci-lxc-deployer-v0.2.0) (2026-02-23)


### Features

* Add application_name to OCI outputs and pass it to VM creation ([1499dd2](https://github.com/volkmarnissen/oci-lxc-deployer/commit/1499dd24e4cec98733b46551f5e63b84439dd844))
* add enum values API and related functionality ([68e95e3](https://github.com/volkmarnissen/oci-lxc-deployer/commit/68e95e3ab6315a4a6f231b399ef895ebd5994c54))
* Add JSON file to track changes for replacing 'LXC Manager' with 'OCI LXC Deployer' ([f15c719](https://github.com/volkmarnissen/oci-lxc-deployer/commit/f15c7197ed0337277bb72d5308588e117eb9ef73))
* Add OCI image tag to outputs and scripts for enhanced version tracking ([54c958f](https://github.com/volkmarnissen/oci-lxc-deployer/commit/54c958fe7c6c13cbcfa48333a1f10507675f2ba5))
* Add template processing and validation modules ([62f54e8](https://github.com/volkmarnissen/oci-lxc-deployer/commit/62f54e8129e010f7b3c98740b8638b6d6a1c43dc))
* Enhance OCI container listing by decoding config text for accurate parsing ([198bae7](https://github.com/volkmarnissen/oci-lxc-deployer/commit/198bae7e59d5d6403045e037ba978b325ba7bed9))
* Enhance OCI image retrieval by adding application_id and oci_image to output ([8fc4a09](https://github.com/volkmarnissen/oci-lxc-deployer/commit/8fc4a095d0f42dd24dd5bff6438d5aa1da663721))
* First partly stable version: It creates and installs several applications successfully ([#10](https://github.com/volkmarnissen/oci-lxc-deployer/issues/10)) ([b290003](https://github.com/volkmarnissen/oci-lxc-deployer/commit/b29000353cb3dd551211a3cfebb9600af4a9ce0c))
* Implement copy-upgrade functionality for OCI containers ([896303b](https://github.com/volkmarnissen/oci-lxc-deployer/commit/896303b08d2bcc7786c8f7ee3910832b51962ee7))
* Implement script to find variants of "LXC Manager" in the repository ([1b8795d](https://github.com/volkmarnissen/oci-lxc-deployer/commit/1b8795df2c3af6b751b62460973eff94a56d4a38))
* Implement script to replace 'LXC Manager' variants with 'OCI LXC Deployer' ([6d273bb](https://github.com/volkmarnissen/oci-lxc-deployer/commit/6d273bb0798e89de063d7bccaa4f18dcba8dae35))
* migrate to resource-based script and library content handling ([32c38a5](https://github.com/volkmarnissen/oci-lxc-deployer/commit/32c38a5418f6b3d43cd5f23690c755d3ed263714))


### Bug Fixes

* add space in section header for better readability in application development guide ([3683701](https://github.com/volkmarnissen/oci-lxc-deployer/commit/368370193032486ffdc9cbd86ea59a5b8e797f5f))
* Remove redundant newline and improve output formatting in installation script ([caa801e](https://github.com/volkmarnissen/oci-lxc-deployer/commit/caa801e2c89b0427d8cc2e25f5f5dd2ddafa49c9))
* update OWNER variable to match OCI_OWNER in install-lxc-manager.sh ([55f2a4d](https://github.com/volkmarnissen/oci-lxc-deployer/commit/55f2a4da33aff9c6c4b48b1d85fd2bee434e9f52))
* use -a flag in grep to check for existing mounts in bind-multiple-volumes-to-lxc.sh ([4a5a576](https://github.com/volkmarnissen/oci-lxc-deployer/commit/4a5a57640ed5e8196d827bacf47d20e17ead577f))
* Use parameter expansion for OCI_OWNER and OWNER in installation script ([4b829aa](https://github.com/volkmarnissen/oci-lxc-deployer/commit/4b829aa0891c41752c1692bd05fc86822b9b7d4b))


### Refactoring

* migrate tests from Jasmine/Karma to Vitest ([8785609](https://github.com/volkmarnissen/oci-lxc-deployer/commit/8785609bf7e0187008b41d710b2b2cdbc6bb340a))
* remove deprecated test files and helper classes ([173df46](https://github.com/volkmarnissen/oci-lxc-deployer/commit/173df462c44c2af53998c863819cd1d78f807886))
* streamline OCI image download and volume binding in install-lxc-manager.sh ([8254520](https://github.com/volkmarnissen/oci-lxc-deployer/commit/825452079b31503801d28471b62dc7e9bc880bfc))
* update application development guide to improve clarity and remove outdated manual JSON section ([1b7479e](https://github.com/volkmarnissen/oci-lxc-deployer/commit/1b7479edc73c68e595e2694b64cd80d6b4dabf04))
* update installation instructions and enhance application development guide ([af23bc7](https://github.com/volkmarnissen/oci-lxc-deployer/commit/af23bc7eafac4ccca6676c80948d1f5ae4f631b2))
* update template processor interfaces and improve documentation ([f813486](https://github.com/volkmarnissen/oci-lxc-deployer/commit/f8134863e55c278bf43ac1eccf3953f05919f180))
* update tests and script to use template variables for UID/GID mapping ([1238e9b](https://github.com/volkmarnissen/oci-lxc-deployer/commit/1238e9b9bd30bd2468a2c6078fbcadbac9b444d8))
