# WhatsApp API Docker Container

This Docker container runs an API for WhatsApp, allowing for easy and secure integration with WhatsApp for message automation and other services.

## Getting Started

These instructions cover the necessary information to use the Docker container.

### Prerequisites

To run this container, you will need to have Docker installed.

* [Windows](https://docs.docker.com/windows/started)
* [OS X](https://docs.docker.com/mac/started/)
* [Linux](https://docs.docker.com/linux/started/)

### Usage

#### Container Parameters

You can run the container with the following parameters:

```shell
docker run crazynds/whatsapp-api:latest [parameters]
```

Basic usage example:
```shell
docker run -d --name whatsapp-api -p 3000:3000 crazynds/whatsapp-api:latest
```

To start a shell inside the container:
```shell
docker run -it --rm crazynds/whatsapp-api:latest bash

```

#### Environment Variables
* PORT - Port the server will run inside the docker. Default: 3000

#### Volumes
* /app/data - Directory where session are stored.

#### Useful File Locations
* /app - The aplication folder.

## Built With

* Node.js v22.4.0
* Express v4.17.0
* whatsapp-web.js v1.25.0

## Find Us

* [GitHub](https://github.com/crazynds/Whatsapp-Api)
* [Docker Hub](https://hub.docker.com/r/crazynds/whatsapp-api)


## Authors
* [Crazynds](https://github.com/crazynds)

See also the list of contributors who participated in this project.

## License

This project is licensed under the MIT License - see the LICENSE.md file for details.

